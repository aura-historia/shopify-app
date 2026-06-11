export function ensureHtmlToMarkdownRuntime(_baseUrl?: string): Promise<void> {
  return Promise.resolve();
}

export {
  convert,
  WasmConversionOptions,
  WasmHeadingStyle,
  WasmLinkStyle,
  WasmNewlineStyle,
} from "@kreuzberg/html-to-markdown-wasm";
