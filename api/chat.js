/**
 * @file api/chat.js
 * @description 고성능 비동기 스트리밍 처리를 위한 엔터프라이즈급 API 핸들러
 */

export const config = { runtime: 'edge' };

// 환경 변수 검증
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const API_URL = "https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:streamGenerateContent";

/**
 * 모델에게 '초상세 구현'을 강제하는 페르소나 주입
 */
const SYSTEM_PROMPT = `당신은 구글과 오픈AI를 거친 20년차 수석 소프트웨어 아키텍트입니다.
사용자의 요청에 대해 최소 200~300줄 이상의 분량으로 아주 상세한 코드를 작성하세요.
절대로 요약하거나 중간 로직을 생략(// ... 생략)하지 마세요.

필수 포함 사항:
1. 상용 서비스에 즉시 적용 가능한 수준의 예외 처리와 로깅 로직.
2. 각 라인별 공학적 설계 근거를 담은 한글 주석.
3. 디자인 패턴(Singleton, Strategy, Observer 등)의 명확한 적용.
4. 단위 테스트(Unit Test) 및 성능 벤치마크 스크립트 예제.
5. 아키텍처 다이어그램을 텍스트로 표현한 설계 구조 설명.

답변이 짧으면 프로페셔널하지 못한 것으로 간주합니다. 최대한 풍부하게 작성하십시오.`;

export default async function handler(req) {
  // [보안] POST 메서드 외 차단
  if (req.method !== 'POST') {
    return new Response(JSON.stringify({ error: "Method Not Allowed" }), { 
      status: 405, 
      headers: { 'Content-Type': 'application/json' } 
    });
  }

  try {
    const { messages } = await req.json();
    
    // [검증] 메시지 유효성 검사
    if (!messages || !Array.isArray(messages) || messages.length === 0) {
      return new Response(JSON.stringify({ error: "Invalid Messages Format" }), { status: 400 });
    }

    const userMessage = messages[messages.length - 1].content;

    // [설정] Gemini API 페이로드 구성
    const payload = {
      contents: [{
        role: "user",
        parts: [{ text: `${SYSTEM_PROMPT}\n\n[USER REQUEST]: ${userMessage}` }]
      }],
      generationConfig: {
        temperature: 0.8,
        topK: 40,
        topP: 0.95,
        maxOutputTokens: 8192, // 긴 답변을 위해 최대 토큰 설정
        stopSequences: []
      },
      safetySettings: [
        { category: "HARM_CATEGORY_HARASSMENT", threshold: "BLOCK_NONE" },
        { category: "HARM_CATEGORY_HATE_SPEECH", threshold: "BLOCK_NONE" },
        { category: "HARM_CATEGORY_SEXUALLY_EXPLICIT", threshold: "BLOCK_NONE" },
        { category: "HARM_CATEGORY_DANGEROUS_CONTENT", threshold: "BLOCK_NONE" }
      ]
    };

    // [호출] Gemini API 스트리밍 요청
    const response = await fetch(`${API_URL}?key=${GEMINI_API_KEY}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });

    if (!response.ok) {
      const errBody = await response.json();
      throw new Error(`Gemini API Error: ${JSON.stringify(errBody)}`);
    }

    // [스트림] ReadableStream 생성 및 데이터 가공
    const encoder = new TextEncoder();
    const decoder = new TextDecoder();
    const reader = response.body.getReader();

    const customStream = new ReadableStream({
      async start(controller) {
        try {
          while (true) {
            const { done, value } = await reader.read();
            if (done) break;

            const rawChunk = decoder.decode(value, { stream: true });
            
            // 데이터 전송 (클라이언트에서 파싱하기 쉬운 SSE 형식)
            controller.enqueue(encoder.encode(rawChunk));
          }
        } catch (e) {
          controller.error(e);
        } finally {
          controller.close();
        }
      }
    });

    return new Response(customStream, {
      headers: {
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-cache, no-transform',
        'Connection': 'keep-alive',
      }
    });

  } catch (error) {
    console.error("[SERVER ERROR]", error);
    return new Response(JSON.stringify({ error: error.message }), { 
      status: 500,
      headers: { 'Content-Type': 'application/json' }
    });
  }
}
