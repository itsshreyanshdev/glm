import _ from 'lodash';

// 支持的模型列表，基于官方API返回的模型
const SUPPORTED_MODELS = [
    {
        "id": "glm-5.3",
        "name": "GLM-5.3",
        "object": "model",
        "owned_by": "z.ai",
        "description": "GLM-5.3 flagship model - 1M context, advanced reasoning, coding and agent capabilities"
    },
    {
        "id": "glm-4.7",
        "name": "GLM-4.7",
        "object": "model",
        "owned_by": "glm-free-api",
        "description": "Legacy ChatGLM model"
    },
    {
        "id": "glm-4.6v",
        "name": "GLM-4.6v",
        "object": "model",
        "owned_by": "glm-free-api",
        "description": "Legacy ChatGLM vision model"
    },
    {
        "id": "glm-4.6",
        "name": "GLM-4.6",
        "object": "model",
        "owned_by": "glm-free-api",
        "description": "Legacy ChatGLM model"
    }
];

export default {

    prefix: '/v1',

    get: {
        '/models': async () => {
            return {
                "data": SUPPORTED_MODELS
            };
        }

    }
}

// 导出模型验证函数
export function isValidModel(modelId: string): boolean {
    return SUPPORTED_MODELS.some(model => model.id === modelId);
}

// 导出默认模型
export const DEFAULT_MODEL = "glm-5.3";