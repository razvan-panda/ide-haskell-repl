"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const atom_1 = require("atom");
const highlightSync = require("atom-highlight");
const etch = require("etch");
const ide_haskell_repl_base_1 = require("../ide-haskell-repl-base");
const button_1 = require("./button");
const editor_1 = require("./editor");
const termEscapeRx = /\x1B\[([0-9]{1,2}(;[0-9]{1,2})?)?[m|K]/g;
class IdeHaskellReplView extends ide_haskell_repl_base_1.IdeHaskellReplBase {
    constructor(props) {
        super(props.upiPromise, props.state);
        this.props = props;
        this.destroyed = false;
        this.focus = () => {
            this.refs && this.refs.editor && this.refs.editor.element.focus();
        };
        this.disposables = new atom_1.CompositeDisposable();
        this.editor = atom.workspace.buildTextEditor({
            lineNumberGutterVisible: false,
            softWrapped: true,
        });
        const grammar = atom.grammars.grammarForScopeName('source.haskell');
        grammar && this.editor.setGrammar(grammar);
        this.disposables.add(atom.workspace.observeTextEditors((editor) => {
            if (editor.getPath() === this.uri) {
                this.disposables.add(editor.onDidSave(() => {
                    if (this.autoReloadRepeat) {
                        this.ghciReloadRepeat();
                    }
                }));
            }
        }));
        this.disposables.add(atom.config.observe('editor.fontSize', (fontSize) => {
            this.outputFontSize = `${fontSize}px`;
        }));
        this.disposables.add(atom.config.observe('editor.fontFamily', (fontFamily) => {
            this.outputFontFamily = fontFamily;
        }));
        etch.initialize(this);
        if (this.props.state.focus)
            setImmediate(() => this.focus());
        this.registerEditor().catch((e) => {
            atom.notifications.addError(e.toString(), {
                detail: e.stack,
                dismissable: true,
            });
        });
    }
    async execCommand() {
        const inp = this.editor.getBuffer().getText();
        this.editor.setText('');
        if (this.ghci && this.ghci.isBusy()) {
            this.messages.push({
                text: inp,
                hl: false,
                cls: 'ide-haskell-repl-input-text',
            });
            this.ghci.writeRaw(inp);
            return undefined;
        }
        else {
            this.history.save(inp);
            return this.runCommand(inp);
        }
    }
    copyText(command) {
        this.editor.setText(command);
        atom.views.getView(this.editor).focus();
    }
    historyBack() {
        const current = this.editor.getText();
        this.editor.setText(this.history.goBack(current));
    }
    historyForward() {
        this.editor.setText(this.history.goForward());
    }
    clear() {
        this.messages = [];
        this.update();
    }
    getURI() {
        return `ide-haskell://repl/${this.uri}`;
    }
    getTitle() {
        return `REPL: ${this.uri}`;
    }
    async destroy() {
        await etch.destroy(this);
        this.destroyed = true;
        this.disposables.dispose();
        return super.destroy();
    }
    serialize() {
        return {
            deserializer: 'IdeHaskellReplView',
            uri: this.uri,
            content: this.messages,
            history: this.history.serialize(),
            autoReloadRepeat: this.autoReloadRepeat,
            focus: this.isFocused(),
        };
    }
    async update() {
        const atEnd = !!this.refs &&
            this.refs.output.scrollTop + this.refs.output.clientHeight >=
                this.refs.output.scrollHeight;
        const focused = this.isFocused();
        await etch.update(this);
        if (atEnd) {
            this.refs.output.scrollTop =
                this.refs.output.scrollHeight - this.refs.output.clientHeight;
        }
        if (focused) {
            this.focus();
        }
    }
    render() {
        return (etch.dom("div", { className: "ide-haskell-repl", tabIndex: "-1", on: { focus: this.focus } },
            etch.dom("div", { ref: "output", className: "ide-haskell-repl-output native-key-bindings", tabIndex: "-1", style: {
                    fontSize: this.outputFontSize,
                    fontFamily: this.outputFontFamily,
                } }, this.renderOutput()),
            this.renderErrDiv(),
            etch.dom("div", { className: "button-container" },
                this.renderPrompt(),
                etch.dom(button_1.Button, { cls: "reload-repeat", tooltip: "Reload file and repeat last command", command: "ide-haskell-repl:reload-repeat", parent: this }),
                etch.dom(button_1.Button, { cls: "auto-reload-repeat", tooltip: "Toggle reload-repeat on file save", command: "ide-haskell-repl:toggle-auto-reload-repeat", state: this.autoReloadRepeat, parent: this }),
                etch.dom(button_1.Button, { cls: "interrupt", tooltip: "Interrupt current computation", command: "ide-haskell-repl:ghci-interrupt", parent: this }),
                etch.dom(button_1.Button, { cls: "clear", tooltip: "Clear output", command: "ide-haskell-repl:clear-output", parent: this })),
            etch.dom("div", { className: "ide-haskell-repl-editor" },
                etch.dom("div", { className: "editor-container" },
                    etch.dom(editor_1.Editor, { ref: "editor", element: atom.views.getView(this.editor) })))));
    }
    async onInitialLoad() {
        if (!this.ghci) {
            throw new Error('No GHCI instance!');
        }
        const res = await this.ghci.load(this.uri);
        this.prompt = res.prompt[1];
        this.errorsFromStderr(res.stderr);
        return super.onInitialLoad();
    }
    renderErrDiv() {
        if (!this.upi) {
            return etch.dom("div", { className: "ide-haskell-repl-error" }, this.renderErrors());
        }
        else {
            return null;
        }
    }
    renderErrors() {
        return this.errors.map((err) => this.renderError(err));
    }
    renderError(error) {
        const pos = error.position ? atom_1.Point.fromObject(error.position) : undefined;
        const uri = error.uri || '<interactive>';
        const positionText = pos ? `${uri}: ${pos.row + 1}, ${pos.column + 1}` : uri;
        const context = error.context || '';
        return (etch.dom("div", null,
            positionText,
            ": ",
            error.severity,
            ": ",
            context,
            error.message));
    }
    renderPrompt() {
        return (etch.dom("div", { class: "repl-prompt" },
            this.prompt || '',
            ">"));
    }
    renderOutput() {
        const maxMsg = atom.config.get('ide-haskell-repl.maxMessages');
        if (maxMsg > 0) {
            this.messages = this.messages.slice(-maxMsg);
        }
        return this.messages.map((msg) => {
            const { text, cls, hl } = msg;
            let { hlcache } = msg;
            const cleanText = text.replace(termEscapeRx, '');
            if (hl) {
                if (!hlcache) {
                    hlcache = msg.hlcache = highlightSync({
                        fileContents: cleanText,
                        scopeName: 'source.haskell',
                        nbsp: false,
                    });
                }
                return (etch.dom("pre", { className: cls, innerHTML: hlcache }));
            }
            else {
                return etch.dom("pre", { className: cls }, cleanText);
            }
        });
    }
    isFocused() {
        return (!!this.refs &&
            !!document.activeElement &&
            this.refs.editor.element.contains(document.activeElement));
    }
    async registerEditor() {
        const we = await this.props.watchEditorPromise;
        if (this.destroyed)
            return;
        this.disposables.add(we(this.editor, ['ide-haskell-repl']));
    }
}
exports.IdeHaskellReplView = IdeHaskellReplView;
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoiaWRlLWhhc2tlbGwtcmVwbC12aWV3LmpzIiwic291cmNlUm9vdCI6IiIsInNvdXJjZXMiOlsiLi4vLi4vc3JjL3ZpZXdzL2lkZS1oYXNrZWxsLXJlcGwtdmlldy50c3giXSwibmFtZXMiOltdLCJtYXBwaW5ncyI6Ijs7QUFBQSwrQkFBMkU7QUFDM0UsZ0RBQWdEO0FBQ2hELDZCQUE2QjtBQUU3QixvRUFNaUM7QUFDakMscUNBQWlDO0FBQ2pDLHFDQUFpQztBQUtqQyxNQUFNLFlBQVksR0FBRyx5Q0FBeUMsQ0FBQTtBQWE5RCx3QkFBZ0MsU0FBUSwwQ0FBa0I7SUFjeEQsWUFBbUIsS0FBYTtRQUM5QixLQUFLLENBQUMsS0FBSyxDQUFDLFVBQVUsRUFBRSxLQUFLLENBQUMsS0FBSyxDQUFDLENBQUE7UUFEbkIsVUFBSyxHQUFMLEtBQUssQ0FBUTtRQUR4QixjQUFTLEdBQVksS0FBSyxDQUFBO1FBZ0QzQixVQUFLLEdBQUcsR0FBRyxFQUFFO1lBQ2xCLElBQUksQ0FBQyxJQUFJLElBQUksSUFBSSxDQUFDLElBQUksQ0FBQyxNQUFNLElBQUksSUFBSSxDQUFDLElBQUksQ0FBQyxNQUFNLENBQUMsT0FBTyxDQUFDLEtBQUssRUFBRSxDQUFBO1FBQ25FLENBQUMsQ0FBQTtRQS9DQyxJQUFJLENBQUMsV0FBVyxHQUFHLElBQUksMEJBQW1CLEVBQUUsQ0FBQTtRQUU1QyxJQUFJLENBQUMsTUFBTSxHQUFHLElBQUksQ0FBQyxTQUFTLENBQUMsZUFBZSxDQUFDO1lBQzNDLHVCQUF1QixFQUFFLEtBQUs7WUFDOUIsV0FBVyxFQUFFLElBQUk7U0FDbEIsQ0FBQyxDQUFBO1FBQ0YsTUFBTSxPQUFPLEdBQUcsSUFBSSxDQUFDLFFBQVEsQ0FBQyxtQkFBbUIsQ0FBQyxnQkFBZ0IsQ0FBQyxDQUFBO1FBQ25FLE9BQU8sSUFBSSxJQUFJLENBQUMsTUFBTSxDQUFDLFVBQVUsQ0FBQyxPQUFPLENBQUMsQ0FBQTtRQUUxQyxJQUFJLENBQUMsV0FBVyxDQUFDLEdBQUcsQ0FDbEIsSUFBSSxD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QUFFLEtBQUs7cUJBQ1osQ0FBQyxDQUFBO2dCQUNKLENBQUM7Z0JBQ0QsTUFBTSxDQUFDLENBRUwsa0JBQUssU0FBUyxFQUFFLEdBQUcsRUFBRSxTQUFTLEVBQUUsT0FBTyxHQUFJLENBQzVDLENBQUE7WUFDSCxDQUFDO1lBQUMsSUFBSSxDQUFDLENBQUM7Z0JBRU4sTUFBTSxDQUFDLGtCQUFLLFNBQVMsRUFBRSxHQUFHLElBQUcsU0FBUyxDQUFPLENBQUE7WUFDL0MsQ0FBQztRQUNILENBQUMsQ0FBQyxDQUFBO0lBQ0osQ0FBQztJQUVPLFNBQVM7UUFDZixNQUFNLENBQUMsQ0FDTCxDQUFDLENBQUMsSUFBSSxDQUFDLElBQUk7WUFDWCxDQUFDLENBQUMsUUFBUSxDQUFDLGFBQWE7WUFDeEIsSUFBSSxDQUFDLElBQUksQ0FBQyxNQUFNLENBQUMsT0FBTyxDQUFDLFFBQVEsQ0FBQyxRQUFRLENBQUMsYUFBYSxDQUFDLENBQzFELENBQUE7SUFDSCxDQUFDO0lBRU8sS0FBSyxDQUFDLGNBQWM7UUFDMUIsTUFBTSxFQUFFLEdBQUcsTUFBTSxJQUFJLENBQUMsS0FBSyxDQUFDLGtCQUFrQixDQUFBO1FBQzlDLEVBQUUsQ0FBQyxDQUFDLElBQUksQ0FBQyxTQUFTLENBQUM7WUFBQyxNQUFNLENBQUE7UUFDMUIsSUFBSSxDQUFDLFdBQVcsQ0FBQyxHQUFHLENBQUMsRUFBRSxDQUFDLElBQUksQ0FBQyxNQUFNLEVBQUUsQ0FBQyxrQkFBa0IsQ0FBQyxDQUFDLENBQUMsQ0FBQTtJQUM3RCxDQUFDO0NBQ0Y7QUFoU0QsZ0RBZ1NDIiwic291cmNlc0NvbnRlbnQiOlsiaW1wb3J0IHsgQ29tcG9zaXRlRGlzcG9zYWJsZSwgVGV4dEVkaXRvciwgUG9pbnQsIFRXYXRjaEVkaXRvciB9IGZyb20gJ2F0b20nXG5pbXBvcnQgaGlnaGxpZ2h0U3luYyA9IHJlcXVpcmUoJ2F0b20taGlnaGxpZ2h0JylcbmltcG9ydCBldGNoID0gcmVxdWlyZSgnZXRjaCcpXG5cbmltcG9ydCB7XG4gIElDb250ZW50SXRlbSxcbiAgSWRlSGFza2VsbFJlcGxCYXNlLFxuICBJVmlld1N0YXRlLFxuICBJRXJyb3JJdGVtLFxuICBJUmVxdWVzdFJlc3VsdCxcbn0gZnJvbSAnLi4vaWRlLWhhc2tlbGwtcmVwbC1iYXNlJ1xuaW1wb3J0IHsgQnV0dG9uIH0gZnJvbSAnLi9idXR0b24nXG5pbXBvcnQgeyBFZGl0b3IgfSBmcm9tICcuL2VkaXRvcidcbmltcG9ydCAqIGFzIFVQSSBmcm9tICdhdG9tLWhhc2tlbGwtdXBpJ1xuXG5leHBvcnQgeyBJVmlld1N0YXRlLCBJQ29udGVudEl0ZW0sIElSZXF1ZXN0UmVzdWx0IH1cblxuY29uc3QgdGVybUVzY2FwZVJ4ID0gL1xceDFCXFxbKFswLTldezEsMn0oO1swLTldezEsMn0pPyk/W218S10vZ1xuXG5leHBvcnQgaW50ZXJmYWNlIElWaWV3U3RhdGVPdXRwdXQgZXh0ZW5kcyBJVmlld1N0YXRlIHtcbiAgZGVzZXJpYWxpemVyOiBzdHJpbmdcbn1cblxuZXhwb3J0IGludGVyZmFjZSBJUHJvcHMgZXh0ZW5kcyBKU1guUHJvcHMge1xuICB1cGlQcm9taXNlOiBQcm9taXNlPFVQSS5JVVBJSW5zdGFuY2U+XG4gIHN0YXRlOiBJVmlld1N0YXRlXG4gIHdhdGNoRWRpdG9yUHJvbWlzZTogUHJvbWlzZTxUV2F0Y2hFZGl0b3I+XG59XG5cbi8vIHRzbGludDpkaXNhYmxlLW5leHQtbGluZTpuby11bnNhZmUtYW55XG5leHBvcnQgY2xhc3MgSWRlSGFza2VsbFJlcGxWaWV3IGV4dGVuZHMgSWRlSGFza2VsbFJlcGxCYXNlXG4gIGltcGxlbWVudHMgSlNYLkVsZW1lbnRDbGFzcyB7XG4gIC8vIHRzbGludDpkaXNhYmxlLW5leHQtbGluZTpuby11bmluaXRpYWxpemVkXG4gIHB1YmxpYyByZWZzOiB7XG4gICAgb3V0cHV0OiBIVE1MRWxlbWVudFxuICAgIGVkaXRvcjogRWRpdG9yXG4gIH1cbiAgcHVibGljIGVkaXRvcjogVGV4dEVkaXRvclxuICAvLyB0c2xpbnQ6ZGlzYWJsZS1uZXh0LWxpbmU6bm8tdW5pbml0aWFsaXplZFxuICBwcml2YXRlIG91dHB1dEZvbnRGYW1pbHk6IHN0cmluZ1xuICAvLyB0c2xpbnQ6ZGlzYWJsZS1uZXh0LWxpbmU6bm8tdW5pbml0aWFsaXplZFxuICBwcml2YXRlIG91dHB1dEZvbnRTaXplOiBzdHJpbmdcbiAgcHJpdmF0ZSBkaXNwb3NhYmxlczogQ29tcG9zaXRlRGlzcG9zYWJsZVxuICBwcml2YXRlIGRlc3Ryb3llZDogYm9vbGVhbiA9IGZhbHNlXG4gIGNvbnN0cnVjdG9yKHB1YmxpYyBwcm9wczogSVByb3BzKSB7XG4gICAgc3VwZXIocHJvcHMudXBpUHJvbWlzZSwgcHJvcHMuc3RhdGUpXG4gICAgdGhpcy5kaXNwb3NhYmxlcyA9IG5ldyBDb21wb3NpdGVEaXNwb3NhYmxlKClcblxuICAgIHRoaXMuZWRpdG9yID0gYXRvbS53b3Jrc3BhY2UuYnVpbGRUZXh0RWRpdG9yKHtcbiAgICAgIGxpbmVOdW1iZXJHdXR0ZXJWaXNpYmxlOiBmYWxzZSxcbiAgICAgIHNvZnRXcmFwcGVkOiB0cnVlLFxuICAgIH0pXG4gICAgY29uc3QgZ3JhbW1hciA9IGF0b20uZ3JhbW1hcnMuZ3JhbW1hckZvclNjb3BlTmFtZSgnc291cmNlLmhhc2tlbGwnKVxuICAgIGdyYW1tYXIgJiYgdGhpcy5lZGl0b3Iuc2V0R3JhbW1hcihncmFtbWFyKVxuXG4gICAgdGhpcy5kaXNwb3NhYmxlcy5hZGQoXG4gICAgICBhdG9tLndvcmtzcGFjZS5vYnNlcnZlVGV4dEVkaXRvcnMoKGVkaXRvcjogVGV4dEVkaXRvcikgPT4ge1xuICAgICAgICBpZiAoZWRpdG9yLmdldFBhdGgoKSA9PT0gdGhpcy51cmkpIHtcbiAgICAgICAgICB0aGlzLmRpc3Bvc2FibGVzLmFkZChcbiAgICAgICAgICAgIGVkaXRvci5vbkRpZFNhdmUoKCkgPT4ge1xuICAgICAgICAgICAgICBpZiAodGhpcy5hdXRvUmVsb2FkUmVwZWF0KSB7XG4gICAgICAgICAgICAgICAgLy8gdHNsaW50OmRpc2FibGUtbmV4dC1saW5lOm5vLWZsb2F0aW5nLXByb21pc2VzXG4gICAgICAgICAgICAgICAgdGhpcy5naGNpUmVsb2FkUmVwZWF0KClcbiAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgfSksXG4gICAgICAgICAgKVxuICAgICAgICB9XG4gICAgICB9KSxcbiAgICApXG4gICAgdGhpcy5kaXNwb3NhYmxlcy5hZGQoXG4gICAgICBhdG9tLmNvbmZpZy5vYnNlcnZlKCdlZGl0b3IuZm9udFNpemUnLCAoZm9udFNpemU6IG51bWJlcikgPT4ge1xuICAgICAgICB0aGlzLm91dHB1dEZvbnRTaXplID0gYCR7Zm9udFNpemV9cHhgXG4gICAgICB9KSxcbiAgICApXG4gICAgdGhpcy5kaXNwb3NhYmxlcy5hZGQoXG4gICAgICBhdG9tLmNvbmZpZy5vYnNlcnZlKCdlZGl0b3IuZm9udEZhbWlseScsIChmb250RmFtaWx5OiBzdHJpbmcpID0+IHtcbiAgICAgICAgdGhpcy5vdXRwdXRGb250RmFtaWx5ID0gZm9udEZhbWlseVxuICAgICAgfSksXG4gICAgKVxuXG4gICAgZXRjaC5pbml0aWFsaXplKHRoaXMpXG5cbiAgICBpZiAodGhpcy5wcm9wcy5zdGF0ZS5mb2N1cykgc2V0SW1tZWRpYXRlKCgpID0+IHRoaXMuZm9jdXMoKSlcbiAgICB0aGlzLnJlZ2lzdGVyRWRpdG9yKCkuY2F0Y2goKGU6IEVycm9yKSA9PiB7XG4gICAgICBhdG9tLm5vdGlmaWNhdGlvbnMuYWRkRXJyb3IoZS50b1N0cmluZygpLCB7XG4gICAgICAgIGRldGFpbDogZS5zdGFjayxcbiAgICAgICAgZGlzbWlzc2FibGU6IHRydWUsXG4gICAgICB9KVxuICAgIH0pXG4gIH1cblxuICBwdWJsaWMgZm9jdXMgPSAoKSA9PiB7XG4gICAgdGhpcy5yZWZzICYmIHRoaXMucmVmcy5lZGl0b3IgJiYgdGhpcy5yZWZzLmVkaXRvci5lbGVtZW50LmZvY3VzKClcbiAgfVxuXG4gIHB1YmxpYyBhc3luYyBleGVjQ29tbWFuZCgpIHtcbiAgICBjb25zdCBpbnAgPSB0aGlzLmVkaXRvci5nZXRCdWZmZXIoKS5nZXRUZXh0KClcbiAgICB0aGlzLmVkaXRvci5zZXRUZXh0KCcnKVxuICAgIGlmICh0aGlzLmdoY2kgJiYgdGhpcy5naGNpLmlzQnVzeSgpKSB7XG4gICAgICB0aGlzLm1lc3NhZ2VzLnB1c2goe1xuICAgICAgICB0ZXh0OiBpbnAsXG4gICAgICAgIGhsOiBmYWxzZSxcbiAgICAgICAgY2xzOiAnaWRlLWhhc2tlbGwtcmVwbC1pbnB1dC10ZXh0JyxcbiAgICAgIH0pXG4gICAgICB0aGlzLmdoY2kud3JpdGVSYXcoaW5wKVxuICAgICAgcmV0dXJuIHVuZGVmaW5lZFxuICAgIH0gZWxzZSB7XG4gICAgICB0aGlzLmhpc3Rvcnkuc2F2ZShpbnApXG4gICAgICByZXR1cm4gdGhpcy5ydW5Db21tYW5kKGlucClcbiAgICB9XG4gIH1cblxuICBwdWJsaWMgY29weVRleHQoY29tbWFuZDogc3RyaW5nKSB7XG4gICAgdGhpcy5lZGl0b3Iuc2V0VGV4dChjb21tYW5kKVxuICAgIGF0b20udmlld3MuZ2V0Vmlldyh0aGlzLmVkaXRvcikuZm9jdXMoKVxuICB9XG5cbiAgcHVibGljIGhpc3RvcnlCYWNrKCkge1xuICAgIGNvbnN0IGN1cnJlbnQgPSB0aGlzLmVkaXRvci5nZXRUZXh0KClcbiAgICB0aGlzLmVkaXRvci5zZXRUZXh0KHRoaXMuaGlzdG9yeS5nb0JhY2soY3VycmVudCkpXG4gIH1cblxuICBwdWJsaWMgaGlzdG9yeUZvcndhcmQoKSB7XG4gICAgdGhpcy5lZGl0b3Iuc2V0VGV4dCh0aGlzLmhpc3RvcnkuZ29Gb3J3YXJkKCkpXG4gIH1cblxuICBwdWJsaWMgY2xlYXIoKSB7XG4gICAgdGhpcy5tZXNzYWdlcyA9IFtdXG4gICAgLy8gdHNsaW50OmRpc2FibGUtbmV4dC1saW5lOm5vLWZsb2F0aW5nLXByb21pc2VzXG4gICAgdGhpcy51cGRhdGUoKVxuICB9XG5cbiAgcHVibGljIGdldFVSSSgpIHtcbiAgICByZXR1cm4gYGlkZS1oYXNrZWxsOi8vcmVwbC8ke3RoaXMudXJpfWBcbiAgfVxuXG4gIHB1YmxpYyBnZXRUaXRsZSgpIHtcbiAgICByZXR1cm4gYFJFUEw6ICR7dGhpcy51cml9YFxuICB9XG5cbiAgcHVibGljIGFzeW5jIGRlc3Ryb3koKSB7XG4gICAgYXdhaXQgZXRjaC5kZXN0cm95KHRoaXMpXG4gICAgdGhpcy5kZXN0cm95ZWQgPSB0cnVlXG4gICAgdGhpcy5kaXNwb3NhYmxlcy5kaXNwb3NlKClcbiAgICByZXR1cm4gc3VwZXIuZGVzdHJveSgpXG4gIH1cblxuICBwdWJsaWMgc2VyaWFsaXplKCk6IElWaWV3U3RhdGVPdXRwdXQge1xuICAgIHJldHVybiB7XG4gICAgICBkZXNlcmlhbGl6ZXI6ICdJZGVIYXNrZWxsUmVwbFZpZXcnLFxuICAgICAgdXJpOiB0aGlzLnVyaSxcbiAgICAgIGNvbnRlbnQ6IHRoaXMubWVzc2FnZXMsXG4gICAgICBoaXN0b3J5OiB0aGlzLmhpc3Rvcnkuc2VyaWFsaXplKCksXG4gICAgICBhdXRvUmVsb2FkUmVwZWF0OiB0aGlzLmF1dG9SZWxvYWRSZXBlYXQsXG4gICAgICBmb2N1czogdGhpcy5pc0ZvY3VzZWQoKSxcbiAgICB9XG4gIH1cblxuICBwdWJsaWMgYXN5bmMgdXBkYXRlKCkge1xuICAgIGNvbnN0IGF0RW5kID1cbiAgICAgICEhdGhpcy5yZWZzICYmXG4gICAgICB0aGlzLnJlZnMub3V0cHV0LnNjcm9sbFRvcCArIHRoaXMucmVmcy5vdXRwdXQuY2xpZW50SGVpZ2h0ID49XG4gICAgICAgIHRoaXMucmVmcy5vdXRwdXQuc2Nyb2xsSGVpZ2h0XG4gICAgY29uc3QgZm9jdXNlZCA9IHRoaXMuaXNGb2N1c2VkKClcbiAgICBhd2FpdCBldGNoLnVwZGF0ZSh0aGlzKVxuICAgIGlmIChhdEVuZCkge1xuICAgICAgdGhpcy5yZWZzLm91dHB1dC5zY3JvbGxUb3AgPVxuICAgICAgICB0aGlzLnJlZnMub3V0cHV0LnNjcm9sbEhlaWdodCAtIHRoaXMucmVmcy5vdXRwdXQuY2xpZW50SGVpZ2h0XG4gICAgfVxuICAgIGlmIChmb2N1c2VkKSB7XG4gICAgICB0aGlzLmZvY3VzKClcbiAgICB9XG4gIH1cblxuICBwdWJsaWMgcmVuZGVyKCkge1xuICAgIHJldHVybiAoXG4gICAgICAvLyB0c2xpbnQ6ZGlzYWJsZTpuby11bnNhZmUtYW55XG4gICAgICA8ZGl2XG4gICAgICAgIGNsYXNzTmFtZT1cImlkZS1oYXNrZWxsLXJlcGxcIlxuICAgICAgICB0YWJJbmRleD1cIi0xXCJcbiAgICAgICAgb249e3sgZm9jdXM6IHRoaXMuZm9jdXMgfX1cbiAgICAgID5cbiAgICAgICAgPGRpdlxuICAgICAgICAgIHJlZj1cIm91dHB1dFwiXG4gICAgICAgICAgY2xhc3NOYW1lPVwiaWRlLWhhc2tlbGwtcmVwbC1vdXRwdXQgbmF0aXZlLWtleS1iaW5kaW5nc1wiXG4gICAgICAgICAgdGFiSW5kZXg9XCItMVwiXG4gICAgICAgICAgc3R5bGU9e3tcbiAgICAgICAgICAgIGZvbnRTaXplOiB0aGlzLm91dHB1dEZvbnRTaXplLFxuICAgICAgICAgICAgZm9udEZhbWlseTogdGhpcy5vdXRwdXRGb250RmFtaWx5LFxuICAgICAgICAgIH19XG4gICAgICAgID5cbiAgICAgICAgICB7dGhpcy5yZW5kZXJPdXRwdXQoKX1cbiAgICAgICAgPC9kaXY+XG4gICAgICAgIHt0aGlzLnJlbmRlckVyckRpdigpfVxuICAgICAgICA8ZGl2IGNsYXNzTmFtZT1cImJ1dHRvbi1jb250YWluZXJcIj5cbiAgICAgICAgICB7dGhpcy5yZW5kZXJQcm9tcHQoKX1cbiAgICAgICAgICA8QnV0dG9uXG4gICAgICAgICAgICBjbHM9XCJyZWxvYWQtcmVwZWF0XCJcbiAgICAgICAgICAgIHRvb2x0aXA9XCJSZWxvYWQgZmlsZSBhbmQgcmVwZWF0IGxhc3QgY29tbWFuZFwiXG4gICAgICAgICAgICBjb21tYW5kPVwiaWRlLWhhc2tlbGwtcmVwbDpyZWxvYWQtcmVwZWF0XCJcbiAgICAgICAgICAgIHBhcmVudD17dGhpc31cbiAgICAgICAgICAvPlxuICAgICAgICAgIDxCdXR0b25cbiAgICAgICAgICAgIGNscz1cImF1dG8tcmVsb2FkLXJlcGVhdFwiXG4gICAgICAgICAgICB0b29sdGlwPVwiVG9nZ2xlIHJlbG9hZC1yZXBlYXQgb24gZmlsZSBzYXZlXCJcbiAgICAgICAgICAgIGNvbW1hbmQ9XCJpZGUtaGFza2VsbC1yZXBsOnRvZ2dsZS1hdXRvLXJlbG9hZC1yZXBlYXRcIlxuICAgICAgICAgICAgc3RhdGU9e3RoaXMuYXV0b1JlbG9hZFJlcGVhdH1cbiAgICAgICAgICAgIHBhcmVudD17dGhpc31cbiAgICAgICAgICAvPlxuICAgICAgICAgIDxCdXR0b25cbiAgICAgICAgICAgIGNscz1cImludGVycnVwdFwiXG4gICAgICAgICAgICB0b29sdGlwPVwiSW50ZXJydXB0IGN1cnJlbnQgY29tcHV0YXRpb25cIlxuICAgICAgICAgICAgY29tbWFuZD1cImlkZS1oYXNrZWxsLXJlcGw6Z2hjaS1pbnRlcnJ1cHRcIlxuICAgICAgICAgICAgcGFyZW50PXt0aGlzfVxuICAgICAgICAgIC8+XG4gICAgICAgICAgPEJ1dHRvblxuICAgICAgICAgICAgY2xzPVwiY2xlYXJcIlxuICAgICAgICAgICAgdG9vbHRpcD1cIkNsZWFyIG91dHB1dFwiXG4gICAgICAgICAgICBjb21tYW5kPVwiaWRlLWhhc2tlbGwtcmVwbDpjbGVhci1vdXRwdXRcIlxuICAgICAgICAgICAgcGFyZW50PXt0aGlzfVxuICAgICAgICAgIC8+XG4gICAgICAgIDwvZGl2PlxuICAgICAgICA8ZGl2IGNsYXNzTmFtZT1cImlkZS1oYXNrZWxsLXJlcGwtZWRpdG9yXCI+XG4gICAgICAgICAgPGRpdiBjbGFzc05hbWU9XCJlZGl0b3ItY29udGFpbmVyXCI+XG4gICAgICAgICAgICA8RWRpdG9yIHJlZj1cImVkaXRvclwiIGVsZW1lbnQ9e2F0b20udmlld3MuZ2V0Vmlldyh0aGlzLmVkaXRvcil9IC8+XG4gICAgICAgICAgPC9kaXY+XG4gICAgICAgIDwvZGl2PlxuICAgICAgPC9kaXY+XG4gICAgICAvLyB0c2xpbnQ6ZW5hYmxlOm5vLXVuc2FmZS1hbnlcbiAgICApXG4gIH1cblxuICBwcm90ZWN0ZWQgYXN5bmMgb25Jbml0aWFsTG9hZCgpIHtcbiAgICBpZiAoIXRoaXMuZ2hjaSkge1xuICAgICAgdGhyb3cgbmV3IEVycm9yKCdObyBHSENJIGluc3RhbmNlIScpXG4gICAgfVxuICAgIGNvbnN0IHJlcyA9IGF3YWl0IHRoaXMuZ2hjaS5sb2FkKHRoaXMudXJpKVxuICAgIHRoaXMucHJvbXB0ID0gcmVzLnByb21wdFsxXVxuICAgIHRoaXMuZXJyb3JzRnJvbVN0ZGVycihyZXMuc3RkZXJyKVxuICAgIHJldHVybiBzdXBlci5vbkluaXRpYWxMb2FkKClcbiAgfVxuXG4gIHByaXZhdGUgcmVuZGVyRXJyRGl2KCkge1xuICAgIGlmICghdGhpcy51cGkpIHtcbiAgICAgIHJldHVybiA8ZGl2IGNsYXNzTmFtZT1cImlkZS1oYXNrZWxsLXJlcGwtZXJyb3JcIj57dGhpcy5yZW5kZXJFcnJvcnMoKX08L2Rpdj5cbiAgICB9IGVsc2Uge1xuICAgICAgLy8gdHNsaW50OmRpc2FibGUtbmV4dC1saW5lOiBuby1udWxsLWtleXdvcmRcbiAgICAgIHJldHVybiBudWxsXG4gICAgfVxuICB9XG5cbiAgcHJpdmF0ZSByZW5kZXJFcnJvcnMoKSB7XG4gICAgcmV0dXJuIHRoaXMuZXJyb3JzLm1hcCgoZXJyKSA9PiB0aGlzLnJlbmRlckVycm9yKGVycikpXG4gIH1cblxuICBwcml2YXRlIHJlbmRlckVycm9yKGVycm9yOiBJRXJyb3JJdGVtKSB7XG4gICAgY29uc3QgcG9zID0gZXJyb3IucG9zaXRpb24gPyBQb2ludC5mcm9tT2JqZWN0KGVycm9yLnBvc2l0aW9uKSA6IHVuZGVmaW5lZFxuICAgIGNvbnN0IHVyaSA9IGVycm9yLnVyaSB8fCAnPGludGVyYWN0aXZlPidcbiAgICBjb25zdCBwb3NpdGlvblRleHQgPSBwb3MgPyBgJHt1cml9OiAke3Bvcy5yb3cgKyAxfSwgJHtwb3MuY29sdW1uICsgMX1gIDogdXJpXG4gICAgY29uc3QgY29udGV4dCA9IGVycm9yLmNvbnRleHQgfHwgJydcbiAgICByZXR1cm4gKFxuICAgICAgLy8gdHNsaW50OmRpc2FibGU6bm8tdW5zYWZlLWFueVxuICAgICAgPGRpdj5cbiAgICAgICAge3Bvc2l0aW9uVGV4dH06IHtlcnJvci5zZXZlcml0eX06IHtjb250ZXh0fVxuICAgICAgICB7ZXJyb3IubWVzc2FnZX1cbiAgICAgIDwvZGl2PlxuICAgICAgLy8gdHNsaW50OmVuYWJsZTpuby11bnNhZmUtYW55XG4gICAgKVxuICB9XG5cbiAgcHJpdmF0ZSByZW5kZXJQcm9tcHQoKSB7XG4gICAgcmV0dXJuIChcbiAgICAgIC8vIHRzbGludDpkaXNhYmxlLW5leHQtbGluZTpuby11bnNhZmUtYW55XG4gICAgICA8ZGl2IGNsYXNzPVwicmVwbC1wcm9tcHRcIj57dGhpcy5wcm9tcHQgfHwgJyd9Jmd0OzwvZGl2PlxuICAgIClcbiAgfVxuXG4gIHByaXZhdGUgcmVuZGVyT3V0cHV0KCkge1xuICAgIGNvbnN0IG1heE1zZyA9IGF0b20uY29uZmlnLmdldCgnaWRlLWhhc2tlbGwtcmVwbC5tYXhNZXNzYWdlcycpXG4gICAgaWYgKG1heE1zZyA+IDApIHtcbiAgICAgIHRoaXMubWVzc2FnZXMgPSB0aGlzLm1lc3NhZ2VzLnNsaWNlKC1tYXhNc2cpXG4gICAgfVxuICAgIHJldHVybiB0aGlzLm1lc3NhZ2VzLm1hcCgobXNnOiBJQ29udGVudEl0ZW0pID0+IHtcbiAgICAgIGNvbnN0IHsgdGV4dCwgY2xzLCBobCB9ID0gbXNnXG4gICAgICBsZXQgeyBobGNhY2hlIH0gPSBtc2dcbiAgICAgIGNvbnN0IGNsZWFuVGV4dCA9IHRleHQucmVwbGFjZSh0ZXJtRXNjYXBlUngsICcnKVxuICAgICAgaWYgKGhsKSB7XG4gICAgICAgIGlmICghaGxjYWNoZSkge1xuICAgICAgICAgIGhsY2FjaGUgPSBtc2cuaGxjYWNoZSA9IGhpZ2hsaWdodFN5bmMoe1xuICAgICAgICAgICAgZmlsZUNvbnRlbnRzOiBjbGVhblRleHQsXG4gICAgICAgICAgICBzY29wZU5hbWU6ICdzb3VyY2UuaGFza2VsbCcsXG4gICAgICAgICAgICBuYnNwOiBmYWxzZSxcbiAgICAgICAgICB9KVxuICAgICAgICB9XG4gICAgICAgIHJldHVybiAoXG4gICAgICAgICAgLy8gdHNsaW50OmRpc2FibGUtbmV4dC1saW5lOm5vLXVuc2FmZS1hbnlcbiAgICAgICAgICA8cHJlIGNsYXNzTmFtZT17Y2xzfSBpbm5lckhUTUw9e2hsY2FjaGV9IC8+XG4gICAgICAgIClcbiAgICAgIH0gZWxzZSB7XG4gICAgICAgIC8vIHRzbGludDpkaXNhYmxlLW5leHQtbGluZTpuby11bnNhZmUtYW55XG4gICAgICAgIHJldHVybiA8cHJlIGNsYXNzTmFtZT17Y2xzfT57Y2xlYW5UZXh0fTwvcHJlPlxuICAgICAgfVxuICAgIH0pXG4gIH1cblxuICBwcml2YXRlIGlzRm9jdXNlZCgpIHtcbiAgICByZXR1cm4gKFxuICAgICAgISF0aGlzLnJlZnMgJiZcbiAgICAgICEhZG9jdW1lbnQuYWN0aXZlRWxlbWVudCAmJlxuICAgICAgdGhpcy5yZWZzLmVkaXRvci5lbGVtZW50LmNvbnRhaW5zKGRvY3VtZW50LmFjdGl2ZUVsZW1lbnQpXG4gICAgKVxuICB9XG5cbiAgcHJpdmF0ZSBhc3luYyByZWdpc3RlckVkaXRvcigpIHtcbiAgICBjb25zdCB3ZSA9IGF3YWl0IHRoaXMucHJvcHMud2F0Y2hFZGl0b3JQcm9taXNlXG4gICAgaWYgKHRoaXMuZGVzdHJveWVkKSByZXR1cm5cbiAgICB0aGlzLmRpc3Bvc2FibGVzLmFkZCh3ZSh0aGlzLmVkaXRvciwgWydpZGUtaGFza2VsbC1yZXBsJ10pKVxuICB9XG59XG4iXX0=