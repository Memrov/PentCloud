export function catalogFixture(request: Request): Response {
  const url = new URL(request.url);
  if (url.pathname === "/catalog-upstream") {
    if (request.headers.has("Authorization"))
      throw new Error("Public catalogs must not receive a key");
    if (url.searchParams.has("redirect"))
      return new Response(null, {
        status: 302,
        headers: { Location: "/must-not-follow" }
      });
    const route = url.searchParams.get("route");
    return Response.json({
      data: [
        {
          id: "native-catalog",
          type: "chat",
          capabilities: { tools: { supported: true } },
          api: {
            "chat-completions": {
              base_url:
                "https://opencode.ai/inference/" +
                (route === "go" ? "go/" : "") +
                "openai/v1"
            }
          }
        }
      ]
    });
  }
  return new Response("not found", { status: 404 });
}
