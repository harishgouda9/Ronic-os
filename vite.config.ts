import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

function makeProxy(target: string, prefix: string) {
  return {
    target,
    changeOrigin: true,
    rewrite: (path: string) => path.replace(new RegExp(`^${prefix}`), ""),
    configure: (proxy: any) => {
      proxy.on("error", (err: any, _req: any, res: any) => {
        if (res && "writeHead" in res && !res.headersSent) {
          res.writeHead(503, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: err?.message || "Proxy target unavailable", code: err?.code }));
        }
      });
    },
  };
}

export default defineConfig({
  plugins: [react(), tailwindcss()],
  clearScreen: false,
  server: {
    port: 1420,
    strictPort: true,
    host: true,
    proxy: {
      "/proxy/openai": makeProxy("https://api.openai.com", "/proxy/openai"),
      "/proxy/xai": makeProxy("https://api.x.ai", "/proxy/xai"),
      "/proxy/openrouter": makeProxy("https://openrouter.ai", "/proxy/openrouter"),
      "/proxy/deepseek": makeProxy("https://api.deepseek.com", "/proxy/deepseek"),
      "/proxy/qwen": makeProxy("https://dashscope.aliyuncs.com", "/proxy/qwen"),
      "/proxy/anthropic": makeProxy("https://api.anthropic.com", "/proxy/anthropic"),
      "/proxy/gemini": makeProxy("https://generativelanguage.googleapis.com", "/proxy/gemini"),
      "/proxy/tokenrouter": makeProxy("https://api.tokenrouter.io", "/proxy/tokenrouter"),
      "/proxy/bedrock": makeProxy("https://bedrock-runtime.us-east-1.amazonaws.com", "/proxy/bedrock"),
      "/proxy/ollama": makeProxy("http://127.0.0.1:11434", "/proxy/ollama"),
      "/proxy/nvidia": makeProxy("https://integrate.api.nvidia.com", "/proxy/nvidia"),
      "/proxy/mistral": makeProxy("https://api.mistral.ai", "/proxy/mistral"),
      "/proxy/groq": makeProxy("https://api.groq.com", "/proxy/groq"),
      "/proxy/perplexity": makeProxy("https://api.perplexity.ai", "/proxy/perplexity"),
      "/proxy/together": makeProxy("https://api.together.xyz", "/proxy/together"),
      "/proxy/cohere": makeProxy("https://api.cohere.com", "/proxy/cohere"),
    },
  },
  envPrefix: ["VITE_", "TAURI_"],
  build: {
    target: "esnext",
    sourcemap: !!process.env.TAURI_ENV_DEBUG,
  },
});
