import {Range} from 'atom'
import * as Util from 'atom-haskell-utils'
import {filter} from 'fuzzaldrin'

import {CommandHistory} from './command-history'
import {GHCI} from './ghci'

export interface IViewState {
  uri?: string
  history?: string[]
  autoReloadRepeat?: boolean
  content?: IContentItem[]
}

export interface IContentItem {
  text: string
  cls: string
  hl?: boolean
  hlcache?: string
}

export interface IErrorItem extends UPI.IResultItem { _time: number }

export abstract class IdeHaskellReplBase {
  public static async getRootDir (uri: string) {
    return Util.getRootDir(uri)
  }

  public static async getCabalFile (rootDir: AtomTypes.Directory): Promise<AtomTypes.File[]> {
    const cont = await new Promise<Array<AtomTypes.Directory | AtomTypes.File>>(
      (resolve, reject) => rootDir.getEntries((error, contents) => {
        if (error) {
          reject(error)
        } else {
          resolve(contents)
        }
      }),
    )
    return cont.filter((file) =>
        file.isFile() && file.getBaseName().endsWith('.cabal')) as AtomTypes.File[]
  }

  public static async parseCabalFile (cabalFile: AtomTypes.File): Promise<Util.IDotCabal | null> {
    const cabalContents = await cabalFile.read()
    return Util.parseDotCabal(cabalContents)
  }

  public static async getComponent (cabalFile: AtomTypes.File, uri: string): Promise<string[]> {
    const cabalContents = await cabalFile.read()
    const cwd = cabalFile.getParent()
    return Util.getComponentFromFile(cabalContents, cwd.relativize(uri))
  }

  public static async componentFromURI (uri: string) {
    const cwd = await IdeHaskellReplBase.getRootDir(uri)
    const [cabalFile] = await IdeHaskellReplBase.getCabalFile(cwd)

    let comp, cabal
    if (cabalFile) {
      cabal = await IdeHaskellReplBase.parseCabalFile(cabalFile);
      [comp] = await IdeHaskellReplBase.getComponent(cabalFile, cwd.relativize(uri))
    }
    return {cwd, comp, cabal}
  }

  protected ghci?: GHCI
  protected cwd?: AtomTypes.Directory
  protected prompt: string
  protected upi?: UPI.IUPIInstance
  protected messages: IContentItem[]
  protected errors: IErrorItem[]
  protected _autoReloadRepeat: boolean
  protected history: CommandHistory
  protected uri: string

  constructor (upiPromise: Promise<UPI.IUPIInstance>, {
    uri, content, history, autoReloadRepeat = atom.config.get('ide-haskell-repl.autoReloadRepeat'),
  }: IViewState) {
    this.uri = uri || ''
    this.history = new CommandHistory(history)
    this._autoReloadRepeat = autoReloadRepeat
    this.errors = []
    this.prompt = ''

    this.messages = content || []

    this.initialize(upiPromise)
  }

  public abstract async update (): Promise<void>

  public toggleAutoReloadRepeat () {
    this.autoReloadRepeat = ! this.autoReloadRepeat
  }

  public async runCommand (command: string) {
    if (!this.ghci) { throw new Error('No GHCI instance!') }
    const inp = command.split('\n')
    const res = await this.ghci.writeLines(inp, (lineInfo) => {
      switch (lineInfo.type) {
        case 'stdin':
          lineInfo.line && this.messages.push({
            text: inp.join('\n'), hl: true, cls: 'ide-haskell-repl-input-text',
          })
          break
        case 'stdout':
          lineInfo.line && this.messages.push({
            text: lineInfo.line, hl: true, cls: 'ide-haskell-repl-output-text',
          })
          break
        case 'prompt':
          this.prompt = lineInfo.prompt[1]
          break
        default: break
      }
      this.update()
    })
    this.errorsFromStderr(res.stderr)
    return res
  }

  public async ghciReload () {
    if (!this.ghci) { throw new Error('No GHCI instance!') }
    const res = await this.ghci.reload()
    this.onReload()
    return res
  }

  public async ghciReloadRepeat () {
    const {stderr} = await this.ghciReload()
    if (! this.errorsFromStderr(stderr)) {
      const command = this.history.peek(-1)
      if (command) {
        return this.runCommand(command)
      }
    }
  }

  public set autoReloadRepeat (autoReloadRepeat: boolean) {
    this._autoReloadRepeat = autoReloadRepeat
    this.update()
  }

  public get autoReloadRepeat () {
    return this._autoReloadRepeat
  }

  public interrupt () {
    if (!this.ghci) { throw new Error('No GHCI instance!') }
    this.ghci.interrupt()
  }

  public async getCompletions (prefix: string) {
    if (!prefix.trim()) {
      return []
    }
    if (!this.ghci) { throw new Error('No GHCI instance!') }
    const {stdout} = await this.ghci.sendCompletionRequest()
    stdout.shift()
    return filter(stdout, prefix).map((text) => ({text: text.slice(1, -1)}))
  }

  protected async onInitialLoad () {
    return this.onLoad()
  }

  protected async onReload () {
    return this.onLoad()
  }

  protected async onLoad () {
    // noop
  }

  protected async destroy () {
    if (this.ghci) {
      this.ghci.destroy()
    }
  }

  protected async initialize (upiPromise: Promise<UPI.IUPIInstance>) {
    this.upi = await upiPromise
    if (!this.upi) { return this.runREPL(null) }

    try {
      const builder = await this.upi.getOthersConfigParam('ide-haskell-cabal', 'builder') as {name: string}
      this.runREPL((builder || {}).name)
    } catch (error) {
      if (error) {
        atom.notifications.addFatalError(error.toString(), {
          detail: error,
          dismissable: true,
        })
        this.destroy()
      } else {
        atom.notifications.addWarning("Can't run REPL without knowing what builder to use")
        this.destroy()
      }
    }
  }

  protected async runREPL (inbuilder: string | null) {
    let builder = inbuilder || atom.config.get('ide-haskell-repl.defaultRepl')
    const subst = {
      'nix-build': 'cabal',
      'none': 'ghci',
    }
    builder = (subst[builder] || builder)

    const {cwd, comp, cabal} = await IdeHaskellReplBase.componentFromURI(this.uri)
    this.cwd = cwd

    const commandPath = atom.config.get(`ide-haskell-repl.${builder}Path`)

    const args = {
      stack: ['ghci'],
      cabal: ['repl'],
      ghci: [],
    }
    const extraArgs = {
      stack: (x: string) => `--ghci-options="${x}"`,
      cabal: (x: string) => `--ghc-option=${x}`,
      ghci: (x: string) => x,
    }

    if (!args[builder]) { throw new Error(`Unknown builder ${builder}`) }
    const commandArgs = args[builder]

    commandArgs.push(...(atom.config.get('ide-haskell-repl.extraArgs').map(extraArgs[builder])))

    if (comp && cabal) {
      if (builder === 'stack') {
        const compc =
          comp.startsWith('lib:')
          ? 'lib'
          : comp
        commandArgs.push('--main-is', `${cabal.name}:${compc}`)
      } else {
        commandArgs.push(comp)
      }
    }

    this.ghci = new GHCI({
      atomPath: process.execPath,
      command: commandPath,
      args: commandArgs,
      cwd: this.cwd.getPath(),
      onExit: async (code) => this.destroy(),
    })

    const initres = await this.ghci.waitReady()
    this.prompt = initres.prompt[1]
    this.errorsFromStderr (initres.stderr)
    await this.onInitialLoad()
    this.update()
  }

  protected errorsFromStderr (stderr: string[]): boolean {
    this.errors = this.errors.filter(({_time}) => Date.now() - _time < 10000)
    let hasErrors = false
    for (const err of stderr.join('\n').split(/\n(?=\S)/)) {
      if (err) {
        const error = this.parseMessage(err)
        if (error) {
          this.errors.push(error)
          if (error.severity === 'error') {
            hasErrors = true
          }
        }
      }
    }
    if (this.upi) {
      this.upi.setMessages(this.errors)
    } else {
      this.update()
    }
    return hasErrors
  }

  protected unindentMessage (message: string): string {
    let lines = message.split('\n').filter((x) => !x.match(/^\s*$/))
    let minIndent: number | null = null
    for (const line of lines) {
      const match = line.match(/^\s*/)!
      const lineIndent = match[0].length
      if (!minIndent || lineIndent < minIndent) { minIndent = lineIndent }
    }
    if (minIndent) {
      lines = lines.map((line) => line.slice(minIndent!))
    }
    return lines.join('\n')
  }

  protected parseMessage (raw: string): IErrorItem | undefined {
    if (!this.cwd) { return }
    const matchLoc = /^(.+):(\d+):(\d+):(?: (\w+):)?[ \t]*(\[[^\]]+\])?[ \t]*\n?([^]*)/
    if (raw && raw.trim() !== '') {
      const matched = raw.match(matchLoc)
      if (matched) {
        const [filec, line, col, rawTyp, context, msg]: Array<string | undefined> = matched.slice(1)
        let typ: UPI.TSeverity = rawTyp ? rawTyp.toLowerCase() : 'error'
        let file: string | undefined
        if (filec === '<interactive>') {
          file = undefined
          typ = 'repl'
        } else {
          file = filec
        }

        return {
          uri: file ? this.cwd.getFile(this.cwd.relativize(file)).getPath() : undefined,
          position: [parseInt(line as string, 10) - 1, parseInt(col as string, 10) - 1],
          message: {
            text: this.unindentMessage((msg as string & {trimRight (): string}).trimRight()),
            highlighter: 'hint.message.haskell',
          },
          context,
          severity: typ,
          _time: Date.now(),
        }
      } else {
        return {
          message: raw,
          severity: 'repl',
          _time: Date.now(),
        }
      }
    }
  }
}