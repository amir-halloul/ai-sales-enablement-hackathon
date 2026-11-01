import { describe, expect, it } from 'vitest';
import { citedSource, WebSearchClient, type WebSearchRequest } from './web-search.client.js';
import { loadWebSearchConfig } from './web-search.config.js';

const CONFIGURED = { OPENAI_API_KEY: 'test-key' };

const REQUEST: WebSearchRequest = {
  operation: 'company-facts',
  instructions: 'Research the company.',
  input: 'Company: Example Corp',
  schemaName: 'company-facts',
  schema: { type: 'object', additionalProperties: false, required: [], properties: {} },
};

const options = () => ({ deadline: Date.now() + 5000, correlationId: 'test' });

function responsesBody(answerText: string): unknown {
  return {
    object: 'response',
    status: 'completed',
    output: [
      { type: 'reasoning', id: 'rs_1', summary: [] },
      {
        type: 'web_search_call',
        id: 'ws_1',
        status: 'completed',
        action: { type: 'search', query: 'Example Corp', sources: [{ type: 'url', url: 'https://www.example.com/about' }] },
      },
      {
        type: 'message',
        role: 'assistant',
        content: [
          {
            type: 'output_text',
            text: answerText,
            annotations: [{ type: 'url_citation', url: 'https://news.example.org/story?id=7', title: 'Story', start_index: 0, end_index: 1 }],
          },
        ],
      },
    ],
    usage: { input_tokens: 100, output_tokens: 20, total_tokens: 120 },
  };
}

function client(fetchFn: typeof fetch, env: Record<string, string> = CONFIGURED) {
  return new WebSearchClient(loadWebSearchConfig(env), fetchFn);
}

describe('WebSearchClient', () => {
  it('runs an OpenAI model with the web_search tool and collects the pages the search consulted', async () => {
    let sent: { url: string; init: RequestInit } | undefined;
    const fetchFn: typeof fetch = (url, init) => {
      sent = { url: url as string, init: init ?? {} };
      return Promise.resolve(Response.json(responsesBody('```json\n{"website":"https://www.example.com"}\n```')));
    };

    const answer = await client(fetchFn).search(REQUEST, options());

    expect(sent?.url).toBe('https://api.openai.com/v1/responses');
    expect(sent?.init.headers).toMatchObject({ authorization: 'Bearer test-key' });
    const body = JSON.parse(sent?.init.body as string) as { input: string };
    expect(body).toMatchObject({
      model: 'gpt-6-luna',
      instructions: REQUEST.instructions,
      tools: [{ type: 'web_search' }],
      include: ['web_search_call.action.sources'],
      reasoning: { effort: 'low' },
      store: false,
    });
    expect(body.input).toContain(REQUEST.input);
    expect(body.input).toContain('"company-facts"');
    expect(body.input).toContain(JSON.stringify(REQUEST.schema));

    expect(answer.output).toEqual({ website: 'https://www.example.com' });
    expect(answer.usage).toEqual({ searches: 1, inputTokens: 100, outputTokens: 20 });
    expect(citedSource(answer, 'https://example.com/about/')).toBe('https://www.example.com/about');
    expect(citedSource(answer, 'http://news.example.org/story?id=7#top')).toBe('https://news.example.org/story?id=7');
    expect(citedSource(answer, 'https://www.example.com/made-up')).toBeUndefined();
    expect(citedSource(answer, null)).toBeUndefined();
  });

  it.each([
    [400, 'invalid_request'],
    [401, 'auth_failed'],
    [403, 'auth_failed'],
    [429, 'rate_limited'],
    [503, 'upstream_unavailable'],
  ])('maps HTTP %i to %s', async (status, code) => {
    const fetchFn: typeof fetch = () => Promise.resolve(new Response('{"message":"no"}', { status }));
    await expect(client(fetchFn).search(REQUEST, options())).rejects.toMatchObject({ code });
  });

  it('rejects an answer that is not JSON', async () => {
    const fetchFn: typeof fetch = () => Promise.resolve(Response.json(responsesBody('Sorry, I cannot help with that.')));
    await expect(client(fetchFn).search(REQUEST, options())).rejects.toMatchObject({ code: 'malformed_response' });
  });

  it('rejects an incomplete response', async () => {
    const incomplete = { ...(responsesBody('{"website":') as object), status: 'incomplete' };
    const fetchFn: typeof fetch = () => Promise.resolve(Response.json(incomplete));
    await expect(client(fetchFn).search(REQUEST, options())).rejects.toMatchObject({ code: 'malformed_response' });
  });

  it('sends the configured model and reasoning effort', async () => {
    let body: unknown;
    const fetchFn: typeof fetch = (_url, init) => {
      body = JSON.parse(init?.body as string);
      return Promise.resolve(Response.json(responsesBody('{}')));
    };
    await client(fetchFn, { ...CONFIGURED, WEB_SEARCH_MODEL: 'gpt-4.1', OPENAI_REASONING_EFFORT: 'default' }).search(REQUEST, options());
    expect(body).toMatchObject({ model: 'gpt-4.1' });
    expect(body).not.toHaveProperty('reasoning');
  });

  it('uses OPENAI_BASE_URL for an OpenAI-compatible gateway', () => {
    expect(loadWebSearchConfig({ ...CONFIGURED, OPENAI_BASE_URL: 'https://gateway.example.com/openai/v1/' })).toMatchObject({
      baseUrl: 'https://gateway.example.com/openai/v1',
    });
  });

  it('is unavailable without an OpenAI API key', async () => {
    const unconfigured = client(() => Promise.reject(new Error('not expected')), {});
    expect(unconfigured.isAvailable()).toBe(false);
    await expect(unconfigured.search(REQUEST, options())).rejects.toMatchObject({ code: 'not_configured' });
  });

  it('is unavailable when disabled', async () => {
    const disabled = client(() => Promise.reject(new Error('not expected')), { ...CONFIGURED, WEB_SEARCH_ENABLED: 'false' });
    expect(disabled.isAvailable()).toBe(false);
    await expect(disabled.search(REQUEST, options())).rejects.toMatchObject({ code: 'disabled' });
  });
});

describe('WebSearchClient.ping', () => {
  it('reads the model without running it', async () => {
    let sent: { url: string; init: RequestInit } | undefined;
    const fetchFn: typeof fetch = (url, init) => {
      sent = { url: url as string, init: init ?? {} };
      return Promise.resolve(Response.json({ id: 'gpt-6-luna', object: 'model' }));
    };

    await expect(client(fetchFn).ping(options())).resolves.toBeUndefined();
    expect(sent?.url).toBe('https://api.openai.com/v1/models/gpt-6-luna');
    expect(sent?.init.method).toBe('GET');
    expect(sent?.init.headers).toMatchObject({ authorization: 'Bearer test-key' });
  });

  it.each([
    [401, 'auth_failed'],
    [403, 'auth_failed'],
    [404, 'invalid_request'],
    [429, 'rate_limited'],
    [503, 'upstream_unavailable'],
  ])('maps HTTP %i to %s', async (status, code) => {
    const fetchFn: typeof fetch = () => Promise.resolve(new Response('{"message":"no"}', { status }));
    await expect(client(fetchFn).ping(options())).rejects.toMatchObject({ code });
  });

  it('treats network failures as upstream_unavailable', async () => {
    const fetchFn: typeof fetch = () => Promise.reject(new TypeError('fetch failed'));
    await expect(client(fetchFn).ping(options())).rejects.toMatchObject({ code: 'upstream_unavailable' });
  });
});
