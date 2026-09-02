import { readFileSync } from 'node:fs';
import {
  askNavaAzure,
  buildAzureChatMessages,
  NAVA_AZURE_DEFAULT_BASE,
  NAVA_AZURE_DEFAULT_MODEL,
} from '../apps/server-pilot/src/ops/nava-azure-chat.ts';
import type { NavaDashboard } from '../apps/server-pilot/src/ops/nava-fte-dashboard.ts';

async function main(): Promise<void> {
  const dash = JSON.parse(
    readFileSync('docs/infor-hms/nava-fte-dashboard.json', 'utf8'),
  ) as NavaDashboard;
  const apiKey = readFileSync('.nava_azure_api_key', 'utf8').trim();
  const result = await askNavaAzure({
    config: {
      baseUrl: NAVA_AZURE_DEFAULT_BASE,
      apiKey,
      model: NAVA_AZURE_DEFAULT_MODEL,
    },
    messages: buildAzureChatMessages(dash, [
      {
        role: 'user',
        content: 'In one sentence: why is security quarantine not spam?',
      },
    ]),
  });
  console.log('AZURE_OK', result.ok);
  console.log('AZURE_TEXT', result.text.slice(0, 400));
  if (!result.ok) {
    console.error(result.error);
    process.exit(1);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
