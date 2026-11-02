ollama pull qwen3-embedding:0.6b

export LOCAL_LLM_URL=http://127.0.0.1:11434
export LOCAL_LLM_MODEL=qwen3:8b
export LOCAL_EMBEDDING_MODEL=qwen3-embedding:0.6b

npm start
