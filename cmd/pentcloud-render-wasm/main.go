//go:build js && wasm

package main

import "syscall/js"

func main() {
	callback := js.FuncOf(func(_ js.Value, args []js.Value) any {
		if len(args) != 1 || args[0].Type() != js.TypeString {
			return `{"error":"renderer expects one JSON string"}`
		}
		return renderJSON(args[0].String())
	})
	js.Global().Set("__pentcloudRender", callback)
	// The exported callback remains alive for the lifetime of the isolate. Each
	// render is synchronous, so no Go continuation crosses a Worker request.
	select {}
}
