import { renderLaunch, renderTemplate, promptRendererMemory } from '../../src/native/prompts';

export default {
  async fetch(request: Request): Promise<Response> {
    if (new URL(request.url).pathname === '/memory') {
      return Response.json({ ...await promptRendererMemory(), parentHasGoRuntime: 'Go' in globalThis || '__pentcloudRender' in globalThis });
    }
    const input = await request.json() as {
      operation: string; source: string; data: Record<string, unknown>;
      role: string; args: Record<string, unknown>; context: Parameters<typeof renderLaunch>[3];
    };
    try {
      if (input.operation === 'template') {
        return Response.json({ prompt: await renderTemplate(input.source, input.data) });
      }
      return Response.json(await renderLaunch(input.role, input.args, input.source, input.context));
    } catch (error) {
      return Response.json({ error: error instanceof Error ? error.message : String(error) });
    }
  },
};
