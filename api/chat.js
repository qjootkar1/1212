export const config = { runtime: 'edge' };

async function getQwenGuide(userMessage, apiKey) {
  try {
    const res = await fetch('https://openrouter.ai/api/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: 'qwen/qwen-2.5-72b-instruct:free',
        messages: [
          { role: 'system', content: '시니어 개발자로서 요청에 대한 핵심 설계 구조를 3줄 내외로 요약하세요.' },
          { role: 'user', content: userMessage }
        ],
        max_tokens: 200
      }),
    });
    const data = await res.json();
    return data.choices[0].message.content;
  } catch (e) { return "직접 상세 구현 시작"; }
}

export default async function handler(req) {
  if (req.method === 'OPTIONS') return new Response(null, { status: 200 });

  const { messages } = await req.json();
  const userMessage = messages[messages.length - 1].content;
  const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
  const OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY;

  const stream = new ReadableStream({
    async start(controller) {
      const encoder = new TextEncoder();
      const send = (data) => controller.enqueue(encoder.encode(`data: ${JSON.stringify(data)}\n\n`));

      try {
        // 1단계: Qwen 설계
        send({ stage: 'qwen_start' });
        const guide = await getQwenGuide(userMessage, OPENROUTER_API_KEY);

        // 2단계: Gemini 스트리밍 (잘림 방지 핵심)
        send({ stage: 'gemini_start' });
        const geminiRes = await fetch(
          `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:streamGenerateContent?alt=sse&key=${GEMINI_API_KEY}`,
          {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              contents: [{ parts: [{ text: `설계 가이드: ${guide}\n\n사용자 요청: ${userMessage}\n\n위 내용을 바탕으로 실무에서 즉시 사용 가능한 전체 코드를 아주 상세하고 길게 작성하세요.` }] }]
            }),
          }
        );

        const reader = geminiRes.body.getReader();
        const decoder = new TextDecoder();

        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          const chunk = decoder.decode(value);
          const lines = chunk.split('\n');
          for (const line of lines) {
            if (line.startsWith('data: ')) {
              try {
                const parsed = JSON.parse(line.slice(6));
                const text = parsed.candidates[0].content.parts[0].text;
                send({ stage: 'streaming', chunk: text });
              } catch (e) { continue; }
            }
          }
        }
        send({ stage: 'done' });
      } catch (err) {
        send({ stage: 'error', error: err.message });
      }
      controller.close();
    }
  });

  return new Response(stream, { 
    headers: { 
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive'
    } 
  });
}
