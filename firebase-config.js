// ===== 열방약국 현금정산 설정 =====
// 1) Firebase 콘솔 > 프로젝트 설정 > 내 앱(웹)에서 복사한 값을 아래에 붙여 넣으세요.
export const firebaseConfig = {
  apiKey: "여기에-apiKey",
  authDomain: "여기에-프로젝트ID.firebaseapp.com",
  projectId: "여기에-프로젝트ID",
  storageBucket: "여기에-프로젝트ID.appspot.com",
  messagingSenderId: "여기에-번호",
  appId: "여기에-appId"
};

// 2) 로그인을 허용할 단 하나의 Gmail 주소 (firestore.rules 안의 주소와 반드시 같아야 합니다)
export const OWNER_EMAIL = "nuruk21@gmail.com";

// 3) 이 시간(분) 동안 아무 조작이 없으면 자동 로그아웃
export const IDLE_LOGOUT_MINUTES = 30;
