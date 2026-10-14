// 极简静态文件服务器：为内置浏览器演示页提供 HTTP 服务。
// 用法：node scripts/serve-demo.mjs [port] [rootDir]
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { extname, join, normalize, resolve } from "node:path";

const port = Number(process.argv[2] ?? "8642");
// 静态根目录固定在构建产物 dist-demo，路径参数可覆盖（测试用）。
const rootDir = resolve(process.argv[3] ?? "dist-demo");

/** 扩展名到 Content-Type 的映射（覆盖演示页用到的全部类型）。 */
const MIME_TYPES = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".map": "application/json",
};

const server = createServer(async (request, response) => {
  try {
    const requestPath = decodeURIComponent(
      new URL(request.url ?? "/", "http://localhost").pathname,
    );
    // 归一化并剥掉 .. 前缀，防止路径穿越读取任意文件。
    const relativePath = normalize(requestPath).replace(/^([.][.][/\\])+/, "");
    const target =
      relativePath === "/" || relativePath === "\\"
        ? join(rootDir, "index.html")
        : join(rootDir, relativePath);
    const body = await readFile(target);
    response.writeHead(200, {
      "content-type": MIME_TYPES[extname(target)] ?? "application/octet-stream",
      "cache-control": "no-store",
    });
    response.end(body);
  } catch {
    response.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
    response.end("Not Found");
  }
});

server.listen(port, "127.0.0.1", () => {
  console.log(`演示页已就绪：http://127.0.0.1:${port}/`);
});
