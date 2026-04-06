const QWEN_SYSTEM = `당신은 10년 이상 경력의 시니어 소프트웨어 엔지니어입니다.

[언어 규칙]
- 기본 답변 언어: 한국어
- 사용자가 "영어로 답변해" 또는 "answer in English" 라고 하면 영어로 전환
- 코드(변수명/함수명/클래스명): 항상 영어
- 코드 주석: 기본 한국어, 영어 요청 시 영어

매 요청마다 반드시 다음 순서로 사고하세요:

[사고 과정]
1. 요구사항 분석
   - 정확히 무엇을 요청하는가?
   - 암묵적 요구사항은?
   - 제약조건은?

2. 엣지케이스 나열
   - null/undefined/빈 값 처리?
   - 경계값 조건?
   - 동시성 문제?
   - 보안 취약점?
   - 메모리 누수 가능성?

3. 접근법 선택
   - 가능한 접근법과 트레이드오프?
   - 왜 이 방법이 최선인가?

4. 구현 계획
   - 단계별 분해
   - 필요한 헬퍼 함수?

5. 자체 검토
   - 에러 처리 완료?
   - 엣지케이스 전부 처리?
   - 성능 병목 없음?
   - 보안 취약점 없음?
[/사고 과정]

⚠️ 이 사고 과정은 매 답변마다 반드시 수행하세요. 절대 건너뛰지 마세요.`;

const GEMINI_SYSTEM = `당신은 시니어 코드 리뷰어이자 보안 엔지니어입니다.

[언어 규칙]
- 기본 답변 언어: 한국어
- 사용자가 "영어로 답변해" 또는 "answer in English" 라고 하면 영어로 전환
- 코드(변수명/함수명/클래스명): 항상 영어
- 코드 주석: 기본 한국어, 영어 요청 시 영어

매번 반드시 다음 순서로 검토하세요:

[검토 사고 과정]
1. 정확성 검토 - 로직 버그, 정상 경로 확인
2. 누락된 엣지케이스 - 초안이 놓친 것
3. 보안 감사 - 인젝션, 인증, 데이터 노출
4. 성능 검토 - 불필요한 연산, 메모리
5. 코드 품질 - 가독성, 유지보수성
6. 최종 개선 목록 - 변경사항과 이유
[/검토 사고 과정]

출력 형식:
1. 발견된 문제점 (한국어)
2. 개선된 코드 (영어 코드 + 한국어 주석)
3. 변경사항 요약 (한국어)

⚠️ 매 답변마다 반드시 수행하세요. 절대 건너뛰지 마세요.`;

function addReminder(message) {
  return `${message}

---
⚠️ 상기:
- [사고 과정] 반드시 수행
- 기본 답변은 한국어 (영어 요청 시에만 영어)
- 코드 변수명/함수명은 항상 영어
- 코드 주석은 기본 한국어`;
}

// 토큰 수 추정 (한영 혼용 기준)
function estimateTokens(text) {
  return Math.ceil(text.length / 3);
}

// 순서대로 시도할 무료 Qwen 모델 목록
const QWEN_MODELS = [
  'qwen/qwen3.6-plus:free',
  'qwen/qwen3.6-plus-preview:free',
  'qwen/qwen3-coder:free',
  'qwen/qwen3-235b-a22b:free',
  'qwen/qwen3-30b-a3b:free',
];

async function callQwen(messages) {
  let lastError = null;

  for (const model of QWEN_MODELS) {
    const res = await fetch('https://openrouter.ai/api/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${process.env.OPENROUTER_API_KEY}`,
        'Content-Type': 'application/json',
        'HTTP-Referer': process.env.VERCEL_URL || 'http://localhost:3000',
      },
      body: JSON.stringify({
        model,
        messages,
        max_tokens: 4000,
      })
    });

    if (res.ok) {
      const data = await res.json();
      return data.choices[0].message.content;
    }

    const errText = await res.text();
    // 404(모델없음) 또는 503(사용불가)이면 다음 모델 시도
    if (res.status === 404 || res.status === 503 || res.status === 429) {
      lastError = `${model} 사용불가 (${res.status})`;
      continue;
    }

    // 401(인증오류) 등 다른 에러는 즉시 throw
    throw new Error(`Qwen 오류: ${res.status} - ${errText}`);
  }

  throw new Error(`모든 Qwen 모델 사용불가. 마지막 오류: ${lastError}`);
}

async function callGemini(systemPrompt, userMessage) {
  const res = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${process.env.GEMINI_API_KEY}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        system_instruction: { parts: [{ text: systemPrompt }] },
        contents: [{ parts: [{ text: userMessage }] }],
        generationConfig: { maxOutputTokens: 4000 }
      })
    }
  );

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Gemini 오류: ${res.status} - ${err}`);
  }

  const data = await res.json();
  return data.candidates[0].content.parts[0].text;
}

export default async function handler(req, res) {
  // CORS
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: '허용되지 않는 메서드' });

  const { messages } = req.body;

  if (!messages || !Array.isArray(messages) || messages.length === 0) {
    return res.status(400).json({ error: '메시지가 없습니다' });
  }

  const userMessage = messages[messages.length - 1].content;

  // 토큰 제한 체크
  const inputTokens = estimateTokens(JSON.stringify(messages));
  if (inputTokens > 30000) {
    return res.status(400).json({
      error: `입력이 너무 깁니다 (추정 ${inputTokens} 토큰). 대화를 새로 시작하거나 내용을 줄여주세요.`
    });
  }

  try {
    // SSE 스트리밍 설정
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');

    const sendEvent = (data) => {
      res.write(`data: ${JSON.stringify(data)}\n\n`);
    };

    // 1단계: Qwen CoT
    sendEvent({ stage: 'qwen_start', message: '🧠 Qwen 분석 중...' });

    const qwenMessages = [
      { role: 'system', content: QWEN_SYSTEM },
      ...messages.slice(0, -1),
      { role: 'user', content: addReminder(userMessage) }
    ];

    const qwenDraft = await callQwen(qwenMessages);
    sendEvent({ stage: 'qwen_done', draft: qwenDraft });

    // 파이프라인 토큰 체크
    const pipelineTokens = estimateTokens(qwenDraft + userMessage);
    if (pipelineTokens > 80000) {
      sendEvent({
        stage: 'pipeline_limit',
        message: '⚠️ 토큰 한도 초과 — Qwen 결과만 반환합니다',
        final: qwenDraft
      });
      res.write('data: [DONE]\n\n');
      return res.end();
    }

    // 2단계: Gemini CoT 검토
    sendEvent({ stage: 'gemini_start', message: '🔍 Gemini 검토 중...' });

    const geminiInput = addReminder(`
원본 요청:
${userMessage}

Qwen 초안:
${qwenDraft}

위 초안을 검토하고 개선해줘.`);

    const finalAnswer = await callGemini(GEMINI_SYSTEM, geminiInput);

    sendEvent({
      stage: 'done',
      final: finalAnswer,
      tokens: {
        estimated_input: inputTokens,
        estimated_pipeline: pipelineTokens
      }
    });

    res.write('data: [DONE]\n\n');
    res.end();

  } catch (err) {
    console.error(err);
    res.write(`data: ${JSON.stringify({ stage: 'error', error: err.message })}\n\n`);
    res.write('data: [DONE]\n\n');
    res.end();
  }
}
