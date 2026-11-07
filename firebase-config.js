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
