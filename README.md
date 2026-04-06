# AI Pipeline — Qwen CoT + Gemini CoT

Qwen3.6이 초안 작성 → Gemini 2.5 Flash가 검토/보완하는 듀얼 CoT 파이프라인.
두 모델 모두 무료 API. 비용 $0.

## 세팅 방법

### 1. API 키 발급

**OpenRouter (Qwen용)**
1. https://openrouter.ai 가입
2. API Keys → Create Key
3. 키 복사

**Google AI Studio (Gemini용)**
1. https://aistudio.google.com 접속
2. Get API Key → Create API Key
3. 키 복사

### 2. Vercel 배포

```bash
# Vercel CLI 설치
npm i -g vercel

# 로그인
vercel login

# 배포
vercel

# 환경변수 설정
vercel env add OPENROUTER_API_KEY
vercel env add GEMINI_API_KEY

# 프로덕션 재배포
vercel --prod
```

### 3. 또는 Vercel 대시보드에서 환경변수 설정

1. vercel.com → 프로젝트 선택
2. Settings → Environment Variables
3. OPENROUTER_API_KEY, GEMINI_API_KEY 추가

## 구조

```
api/chat.js        ← 파이프라인 서버리스 함수
public/index.html  ← 채팅 UI
vercel.json        ← 라우팅 설정
```

## 파이프라인 흐름

```
사용자 입력
    ↓
토큰 체크 (30,000 초과 시 차단)
    ↓
Qwen3.6 + 강화 CoT 프롬프트 → 초안 생성
    ↓
파이프라인 토큰 체크 (80,000 초과 시 Qwen 결과만 반환)
    ↓
Gemini 2.5 Flash + 강화 CoT 프롬프트 → 검토/보완
    ↓
최종 출력
```
