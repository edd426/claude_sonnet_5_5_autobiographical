// Renders a page in a real WKWebView, the engine Safari uses, and writes a PNG of the viewport.
// It also prints any script errors and console warnings the page reported, and the result of an
// optional script run after the page has loaded. macOS only; needs the Swift toolchain.
//
//   swiftc -swift-version 5 src/webkit_shot.swift -o /tmp/webkit_shot
//   /tmp/webkit_shot <url> <width> <height> <out.png> <wait-seconds> <dark:0|1> [script-file]
//
// The url can be file:// or http://. The script file is the body of a function: it can `return` a value.
//
// What this found: WebKit paints no blurred text-shadow for text whose color is fully transparent, so the
// fog was invisible until its fill became rgba(0, 0, 0, .01). check_dial.js now guards that.
//
// What it can't show: the view is rendered offscreen, so backdrop-filter blur is not drawn and CSS
// transitions do not advance. A script that injects `*{transition:none!important}` gets final states.
import Cocoa
import WebKit

let args = CommandLine.arguments
if args.count < 7 {
    FileHandle.standardError.write("usage: webkit_shot url width height out.png wait dark [script-file]\n".data(using: .utf8)!)
    exit(2)
}
let urlString = args[1]
let width = CGFloat(Double(args[2]) ?? 1280)
let height = CGFloat(Double(args[3]) ?? 800)
let outPath = args[4]
let waitSeconds = Double(args[5]) ?? 2
let dark = args[6] == "1"
let scriptSource: String? = args.count > 7 ? (try? String(contentsOfFile: args[7], encoding: .utf8)) : nil

final class Host: NSObject, WKNavigationDelegate, WKScriptMessageHandler {
    var web: WKWebView!
    var window: NSWindow!
    var messages: [String] = []

    func start() {
        let conf = WKWebViewConfiguration()
        let ucc = WKUserContentController()
        let hook = WKUserScript(source: """
        (function () {
          var send = function (k, m) { try { window.webkit.messageHandlers.log.postMessage(k + ': ' + m); } catch (e) {} };
          window.addEventListener('error', function (e) { send('error', e.message + ' @' + (e.filename || '') + ':' + e.lineno); });
          window.addEventListener('unhandledrejection', function (e) { send('rejection', String(e.reason)); });
          ['error', 'warn'].forEach(function (k) {
            var o = console[k];
            console[k] = function () { send('console.' + k, Array.prototype.slice.call(arguments).join(' ')); o.apply(console, arguments); };
          });
        })();
        """, injectionTime: .atDocumentStart, forMainFrameOnly: true)
        ucc.addUserScript(hook)
        ucc.add(self, name: "log")
        conf.userContentController = ucc
        web = WKWebView(frame: NSRect(x: 0, y: 0, width: width, height: height), configuration: conf)
        web.navigationDelegate = self
        web.appearance = NSAppearance(named: dark ? .darkAqua : .aqua)
        window = NSWindow(contentRect: NSRect(x: -20000, y: 0, width: width, height: height), styleMask: [.borderless], backing: .buffered, defer: false)
        window.contentView = web
        window.orderFrontRegardless()
        if let url = URL(string: urlString) {
            if url.isFileURL { web.loadFileURL(url, allowingReadAccessTo: url.deletingLastPathComponent()) }
            else { web.load(URLRequest(url: url)) }
        }
    }

    func userContentController(_ c: WKUserContentController, didReceive m: WKScriptMessage) {
        messages.append(String(describing: m.body))
    }

    func webView(_ w: WKWebView, didFinish n: WKNavigation!) {
        DispatchQueue.main.asyncAfter(deadline: .now() + waitSeconds) { self.afterLoad() }
    }
    func webView(_ w: WKWebView, didFail n: WKNavigation!, withError e: Error) { print("navigation failed: \(e)"); exit(1) }
    func webView(_ w: WKWebView, didFailProvisionalNavigation n: WKNavigation!, withError e: Error) { print("load failed: \(e)"); exit(1) }

    func afterLoad() {
        func snap() {
            let cfg = WKSnapshotConfiguration()
            cfg.rect = NSRect(x: 0, y: 0, width: width, height: height)
            web.takeSnapshot(with: cfg) { image, error in
                if let image = image, let tiff = image.tiffRepresentation, let rep = NSBitmapImageRep(data: tiff),
                   let png = rep.representation(using: .png, properties: [:]) {
                    try? png.write(to: URL(fileURLWithPath: outPath))
                    print("wrote \(outPath) (\(png.count) bytes)")
                } else { print("snapshot failed: \(String(describing: error))") }
                for m in self.messages { print("page: \(m)") }
                if self.messages.isEmpty { print("page: no errors or warnings reported") }
                exit(0)
            }
        }
        if let src = scriptSource {
            web.evaluateJavaScript("(function(){ \(src) })()") { result, error in
                if let error = error { print("script error: \(error)") }
                else if let result = result { print("script result: \(result)") }
                DispatchQueue.main.asyncAfter(deadline: .now() + 0.8) { snap() }
            }
        } else { snap() }
    }
}

let app = NSApplication.shared
app.setActivationPolicy(.prohibited)
let host = Host()
host.start()
DispatchQueue.main.asyncAfter(deadline: .now() + 60) { print("timed out"); exit(3) }
app.run()
