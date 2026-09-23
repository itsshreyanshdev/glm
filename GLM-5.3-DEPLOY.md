# GLM-5.3 reverse-engineered deployment

This build keeps the ChatGLM web backend path and selects GLM-5.3 using the same request fields observed in the ChatGLM web client:

- `assistant_id`: `65940acff94777010aa6b796`
- `meta_data.selected_model`: `glm-5.3`
- `meta_data.chat_mode`: `deep_thinking`
- `meta_data.reasoning_effort`: `max`

The bearer token is the ChatGLM `chatglm_refresh_token`, as used by the original project. No Z.AI API key is required by this build.

**Important:** the ChatGLM web endpoint is reverse-engineered and may change without notice. Use only with an account/session you are authorized to use and comply with the service's terms.
