import init, {
  convert,
  WasmConversionOptions,
  WasmHeadingStyle,
  WasmLinkStyle,
  WasmNewlineStyle,
} from "@kreuzberg/html-to-markdown-wasm/pkg/web/html_to_markdown_wasm.js";
import wasmUrl from "@kreuzberg/html-to-markdown-wasm/pkg/web/html_to_markdown_wasm_bg.wasm?url";

await init(wasmUrl);

export {
  convert,
  WasmConversionOptions,
  WasmHeadingStyle,
  WasmLinkStyle,
  WasmNewlineStyle,
};
