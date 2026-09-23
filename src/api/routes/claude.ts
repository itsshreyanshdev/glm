import _ from 'lodash';

import Request from '@/lib/request/Request.ts';
import Response from '@/lib/response/Response.ts';
import chat from '@/api/controllers/chat.ts';
import { createClaudeCompletion } from '@/api/controllers/claude-adapter.ts';

export default {
    prefix: '/v1',
    post: {
        '/messages/count_tokens': async (request: Request) => {
            const body = request.body || {};
            const messages = Array.isArray(body.messages) ? body.messages : [];
            const system = body.system ? JSON.stringify(body.system) : '';
            const tools = Array.isArray(body.tools) ? JSON.stringify(body.tools) : '';
            const text = JSON.stringify(messages) + system + tools;
            // Claude Code only needs a useful estimate for routing/limits.
            const input_tokens = Math.max(1, Math.ceil(text.length / 4));
            return { input_tokens };
        },

        '/messages': async (request: Request) => {
            request
                .validate('body.messages', _.isArray)
                .validate('body.model', _.isString)
                .validate('body.max_tokens', v => _.isUndefined(v) || _.isNumber(v))
                .validate('body.stream', v => _.isUndefined(v) || _.isBoolean(v))
                .validate('body.system', v => _.isUndefined(v) || _.isString(v) || _.isArray(v))
                .validate('body.tools', v => _.isUndefined(v) || _.isArray(v));

            let authHeader = request.headers['x-api-key'] || request.headers.authorization;
            if (!authHeader) {
                throw new Error('Missing API key. Provide x-api-key header or Authorization header.');
            }
            if (!authHeader.startsWith('Bearer ')) {
                authHeader = 'Bearer ' + authHeader;
            }

            const tokens = chat.tokenSplit(authHeader);
            const token = _.sample(tokens);
            if (!token) throw new Error('No valid API token configured.');

            const {
                model,
                messages,
                system,
                stream,
                conversation_id: convId,
                tools = []
            } = request.body;

            if (stream) {
                const claudeStream = await createClaudeCompletion(
                    model,
                    messages,
                    system,
                    token,
                    true,
                    convId,
                    tools
                );
                return new Response(claudeStream, { type: 'text/event-stream' });
            }

            return await createClaudeCompletion(
                model,
                messages,
                system,
                token,
                false,
                convId,
                tools
            );
        }
    }
};
