import { createInterface } from 'node:readline'

const lines = createInterface({ input: process.stdin, crlfDelay: Infinity })
for await (const line of lines) {
    let request
    try { request = JSON.parse(line) } catch { continue }
    if (request.id === undefined) continue
    const result = request.method === 'initialize'
        ? { protocolVersion: '2024-11-05', serverInfo: { name: 'fixture', version: '1' }, capabilities: { tools: {} } }
        : request.method === 'tools/list'
            ? { tools: [{ name: 'echo', description: 'Echo input', inputSchema: { type: 'object', properties: { text: { type: 'string' } } } }] }
            : request.method === 'tools/call'
                ? { content: [{ type: 'text', text: request.params.arguments.text }] }
                : null
    process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: request.id, result }) + '\n')
}
