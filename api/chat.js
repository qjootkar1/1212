import { GoogleGenerativeAI } from "@google/generative-ai";

export const config = { runtime: 'edge' };

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);

const QWEN_SYSTEM = `당신은 시니어 개발자입니다. 사용자 요청에 대해 구현해야 할 핵심 로직과 주의사항을 3줄 이내로 요약하세요.`;
const GEMINI_SYSTEM = `당신은 10년 경력의 시니어 엔지니어입니다. 
전달받은 가이드를 바탕으로 사용자의 요구사항을 완벽하게 충족하는 '매우 상세하고 긴' 전체 코드를 작성하세요. 
주석을 풍부하게 달고, 테스트 케이스와 실행 방법까지 상세히 포함하세요.`;

async function getQwenDraft(messages, apiKey, referer) {
  try {
    const res = await fetch('https://openrouter.ai/api/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
        'HTTP-Referer': referer,
      },
      body: JSON.stringify({
        model: 'qwen/qwen-2.5-72b-instruct:free',
        messages,
        max_tokens: 300,
        temperature: 0.3,
      }),
    });
    if (res.ok) {
      const data = await res.json();
      return data.choices[0].message.content;
    }
  } catch (e) { return "직접 상세 구현 필요"; }
  return "직접 상세 구현 필요";
}

export default async function handler(req) {
  const { messages } = await req.json();
  const userMessage = messages[messages.length - 1].content;
  const OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY;
  const referer = req.headers.get('origin') || 'http://localhost:3000';

  const stream = new ReadableStream({
    async start(controller) {
      const enc = new TextEncoder();
      const send = (data) => controller.enqueue(enc.encode(`data: ${JSON.stringify(data)}\n\n`));

      try {
        send({ stage: 'qwen_start', message: '🏗️ 설계 중...' });
        const qwenGuide = await getQwenDraft([{ role: 'system', content: QWEN_SYSTEM }, { role: 'user', content: userMessage }], OPENROUTER_API_KEY, referer);

        send({ stage: 'gemini_start', message: '🚀 코드 스트리밍 중...' });
        
        const model = genAI.getGenerativeModel({ model: "gemini-2.0-flash" });
        const result = await model.generateContentStream({
          contents: [{ role: 'user', parts: [{ text: `${GEMINI_SYSTEM}\n\n요청: ${userMessage}\n가이드: ${qwenGuide}` }] }],
        });

        let fullText = "";
        for await (const chunk of result.stream) {
          const chunkText = chunk.text();
          fullText += chunkText;
          send({ stage: 'streaming', chunk: chunkText });
        }

        send({ stage: 'done', final: fullText });
      } catch (err) {
        send({ stage: 'error', error: err.message });
      }
      controller.enqueue(enc.encode('data: [DONE]\n\n'));
      controller.close();
    }
  });

  return new Response(stream, {
    headers: { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' }
  });
}
