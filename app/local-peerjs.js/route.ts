import peerJsSource from "peerjs/dist/peerjs.min.js?raw";

export async function GET() {
  return new Response(peerJsSource, {
    headers: {
      "Content-Type": "text/javascript; charset=utf-8",
      "Cache-Control": "public, max-age=31536000, immutable",
    },
  });
}
