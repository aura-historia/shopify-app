import init, {
  convert,
  WasmConversionOptions,
  WasmHeadingStyle,
  WasmLinkStyle,
  WasmNewlineStyle,
} from "@kreuzberg/html-to-markdown-wasm/pkg/web/html_to_markdown_wasm.js";
import wasmUrl from "@kreuzberg/html-to-markdown-wasm/pkg/web/html_to_markdown_wasm_bg.wasm?url";

let initPromise: Promise<unknown> | undefined;

function resolveWasmUrl(baseUrl?: string): string {
  if (!baseUrl) {
    return wasmUrl;
  }

  return new URL(wasmUrl, baseUrl).toString();
}

export function ensureHtmlToMarkdownRuntime(
  baseUrl?: string,
): Promise<unknown> {
  initPromise ??= init(resolveWasmUrl(baseUrl));
  return initPromise;
}

export {
  convert,
  WasmConversionOptions,
  WasmHeadingStyle,
  WasmLinkStyle,
  WasmNewlineStyle,
};
