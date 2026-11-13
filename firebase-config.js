// ===== 열방약국 현금정산 설정 =====
// 1) Firebase 콘솔 > 프로젝트 설정 > 내 앱(웹)에서 복사한 값을 아래에 붙여 넣으세요.
export const firebaseConfig = {
  apiKey: "AIzaSyBZknKQtggdFofkr0_GcwSzy5Fv6K1hEvU",
  authDomain: "yeolbang-pharmacy-d6ca4.firebaseapp.com",
  projectId: "yeolbang-pharmacy-d6ca4",
  storageBucket: "yeolbang-pharmacy-d6ca4.firebasestorage.app",
  messagingSenderId: "702887170673",
  appId: "1:702887170673:web:5eee5096b8d3a2dc7601d0"
};

// 2) 로그인을 허용할 단 하나의 Gmail 주소 (firestore.rules 안의 주소와 반드시 같아야 합니다)
export const OWNER_EMAIL = "nuruk21@gmail.com";

// 3) 이 시간(분) 동안 아무 조작이 없으면 자동 로그아웃
export const IDLE_LOGOUT_MINUTES = 30;

// 4) 마감 화면 사진 인식(AI) 설정
//    App Check용 reCAPTCHA 사이트 키를 넣어야 사진 인식 기능이 켜집니다. (비어 있으면 기능이 숨겨짐)
export const APP_CHECK_SITE_KEY = "";
export const APP_CHECK_PROVIDER = "v3";   // reCAPTCHA v3 키면 "v3", reCAPTCHA Enterprise 키면 "enterprise"
//    앞에서부터 차례로 시도합니다. 모델이 단종되면 다음 모델을 자동으로 씁니다.
export const GEMINI_MODELS = ["gemini-3.8-flash", "gemini-3.6-flash", "gemini-3.5-flash", "gemini-3-flash-preview"];
