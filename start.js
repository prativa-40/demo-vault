const { spawn, spawnSync } = require('node:child_process');

const embeddingModel = 'qwen3-embedding:0.6b';
const env = {
  ...process.env,
  LOCAL_LLM_URL: 'http://127.0.0.1:11434',
  LOCAL_LLM_MODEL: 'qwen3:8b',
  LOCAL_EMBEDDING_MODEL: embeddingModel,
};

console.log(`Ensuring Ollama model ${embeddingModel} is available...`);
const pull = spawnSync('ollama', ['pull', embeddingModel], {
  stdio: 'inherit',
  env,
});

if (pull.error) {
  console.error(`Could not run Ollama: ${pull.error.message}`);
  process.exit(1);
}

if (pull.status !== 0) {
  process.exit(pull.status ?? 1);
}

console.log('Starting Hearth...');
const server = spawn('npm', ['start'], {
  stdio: 'inherit',
  env,
});

server.on('error', error => {
  console.error(`Could not start Hearth: ${error.message}`);
  process.exit(1);
});

server.on('exit', (code, signal) => {
  if (signal) process.kill(process.pid, signal);
  else process.exit(code ?? 0);
});

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    if (!server.killed) server.kill(signal);
  });
}
