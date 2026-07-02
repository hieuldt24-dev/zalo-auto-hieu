# Đặc tả Yêu cầu Chức năng — ZaloAuto Builder

> **Phiên bản tài liệu:** 1.1
> **Cập nhật:** 2026-07-02 — gỡ bỏ hoàn toàn AI Assistant (xem §2.2, §10 TECH-09)
> **Trạng thái nguồn:** Fork tối giản từ `deplao-builder` (MIT License), chỉ giữ 2 nhóm chức năng cốt lõi.
> **Mục đích tài liệu:** Làm cơ sở để triển khai, mở rộng và kiểm thử app trong tương lai.

---

## 1. Tổng quan

### 1.1. Mô tả sản phẩm
**ZaloAuto** là ứng dụng desktop (Windows/macOS/Linux) quản lý **đa tài khoản Zalo** tập trung trong một giao diện duy nhất, phục vụ đội nhóm bán hàng, chăm sóc khách hàng và marketing. Toàn bộ dữ liệu lưu **local-first** trên máy người dùng (không có backend đám mây bắt buộc).

### 1.2. Mục tiêu
- Quản lý nhiều tài khoản Zalo cùng lúc, mỗi tài khoản có thể gắn proxy riêng.
- Biến Zalo thành một CRM nhẹ: phân loại khách hàng, ghi chú, chiến dịch nhắn tin hàng loạt có kiểm soát.

### 1.3. Đối tượng sử dụng
Shop online, SME, agency marketing, spa, phòng khám, trung tâm giáo dục — bất kỳ đội nhóm nào vận hành bán hàng/CSKH qua Zalo.

### 1.4. Hai trụ cột chức năng
1. **Nhắn tin đa tài khoản Zalo** (Multi-account Messaging)
2. **CRM & Quản lý khách hàng**

---

## 2. Phạm vi

### 2.1. Trong phạm vi (In Scope)
- Quản lý & đăng nhập nhiều tài khoản Zalo (QR + cookie).
- Nhắn tin đầy đủ định dạng (text, ảnh, file, sticker, poll, thu hồi, reaction…).
- CRM: danh bạ, nhãn (Zalo label + local label), ghi chú, chiến dịch gửi hàng loạt.
- Proxy per-account, Lock screen, Dashboard, Báo cáo (Analytics), Cài đặt, Multi-workspace (local).

### 2.2. Ngoài phạm vi (Out of Scope — đã loại bỏ khỏi bản gốc)
- ❌ Facebook (nhắn tin, E2EE bridge, quét nhóm/fanpage).
- ❌ ERP (Task, Calendar, Note, HRM, Notification, Report nhân viên).
- ❌ Workflow automation engine (kéo-thả node) **và** AI auto-reply 24/7.
- ❌ **AI Assistant** (gợi ý trả lời, chat hỏi-đáp, quản lý trợ lý đa nền tảng OpenAI/Claude/Gemini/Deepseek/Grok/Mistral) — đã gỡ bỏ hoàn toàn khỏi bản này (2026-07-02): UI (AIQuickPanel, AIAssistantPage, AIAssistantDetailPage, PromptWizardModal, AccountAssignmentPopup), service (`AIAssistantService`), IPC (`aiAssistantIpc`, `analytics:aiAnalytics`), bảng DB (`ai_assistants`, `ai_assistant_files`, `ai_account_assistants`, `ai_usage_logs`), state liên quan trong `appStore`, tab AI trong Báo cáo, và quyền `ai_assistant` trong phân quyền nhân viên. Lý do: tính năng không có đường vào từ giao diện (dead entry point) và tồn tại lỗi runtime (bảng DB cốt lõi chưa từng được tạo).
- ❌ Quản lý nhân viên + Relay server (Boss↔Employee) + Tunnel công khai + Sync remote.
- ❌ Tích hợp POS/Vận chuyển (KiotViet, Haravan, Sapo, Nhanh, GHN, GHTK, Casso, SePay).
- ❌ Tracking/telemetry gửi dữ liệu về server nhà phát triển.

> ⚠️ Một phần code của các module trên còn tồn tại ở dạng **dormant** (không kích hoạt được) trong "vỏ" ứng dụng — xem [Mục 10 — Backlog kỹ thuật](#10-backlog-kỹ-thuật).

---

## 3. Công nghệ & Kiến trúc

### 3.1. Ngăn xếp công nghệ
| Lớp | Công nghệ |
|---|---|
| Desktop framework | Electron 41 |
| Ngôn ngữ | TypeScript 5 |
| Frontend | React 18, Vite 6, Tailwind CSS 3 |
| State management | Zustand 5 |
| Charts | Recharts 3 (cần `react-is`) |
| Rich text | Quill 2 |
| Database | SQLite qua `better-sqlite3` 12 (WAL mode) |
| Zalo API | `zca-js` 2.1 |
| Proxy | `proxy-agent`, `socks-proxy-agent`, `https-proxy-agent` |
| Bảo mật | `safeStorage` (Electron), `bcryptjs`, `dompurify`, `otplib` |
| Đóng gói | `electron-builder`, JS obfuscator (bản production) |

### 3.2. Mô hình tiến trình
```
[Renderer: React UI]  ⇄  [preload.ts / lib/ipc.ts]  ⇄  [Main process: Electron]
                                                             │
                                              [IPC handlers theo domain]
                                                             │
                                              [Services: Zalo, CRM, DB, File…]
                                                             │
                                              [SQLite local-first + thư mục media]
```

### 3.3. Cây thư mục chính (sau khi trim)
```
electron/
  main.ts                # vòng đời app, cửa sổ, tray, đăng ký IPC
  preload.ts             # cầu nối bảo mật renderer ↔ main
  ipc/                   # loginIpc, zaloIpc, crmIpc,
                         # databaseIpc, fileIpc, proxyIpc, workspaceIpc,
                         # lockScreenIpc, utilIpc
src/
  services/              # crm, database, event, file, http, login, secure, zalo
  models/                # kiểu dữ liệu (account, message, contact, crm, proxy…)
  utils/                 # ConnectionManager, WorkspaceManager, ZaloLoginHelper, ProxyHelper…
  ui/
    App.tsx              # shell, routing theo `view`
    lib/ipc.ts           # wrapper typed quanh window.electronAPI
    store/               # accountStore, chatStore, crmStore, appStore, workspaceStore…
    components/          # auth, chat, crm, dashboard, analytics, settings, layout, common
```

### 3.4. Nguyên tắc IPC
- Mỗi domain một module IPC (`ipcMain.handle` / `ipcRenderer.invoke`), tất cả bất đồng bộ (Promise).
- Renderer chỉ gọi qua `src/ui/lib/ipc.ts` (không gọi trực tiếp `window.electronAPI`).

---

## 4. Yêu cầu chức năng — Quản lý tài khoản Zalo

| ID | Yêu cầu | Ưu tiên |
|---|---|---|
| FR-ACC-01 | Đăng nhập Zalo bằng **QR Code** (hiển thị QR, cập nhật trạng thái realtime, hủy được). | Bắt buộc |
| FR-ACC-02 | Đăng nhập Zalo bằng **Cookie** (imei + cookie + user-agent). | Bắt buộc |
| FR-ACC-03 | Quản lý **nhiều tài khoản** đồng thời; hiển thị danh sách avatar ở Sidebar; kéo-thả sắp xếp. | Bắt buộc |
| FR-ACC-04 | Gắn **proxy riêng cho từng tài khoản** (HTTP/HTTPS/SOCKS4/SOCKS5); proxy áp dụng cho mọi request (login, websocket, upload). | Bắt buộc |
| FR-ACC-05 | Tự động **kết nối lại** các tài khoản active khi mở app; giữ nguyên proxy đã gắn. | Bắt buộc |
| FR-ACC-06 | **Health check** định kỳ (mặc định 60s) + thủ công; hiển thị trạng thái online/offline, listener sống/chết. | Bắt buộc |
| FR-ACC-07 | **Xoá tài khoản** (tuỳ chọn xoá toàn bộ dữ liệu DB + media, hoặc chỉ mark inactive). | Bắt buộc |
| FR-ACC-08 | Làm mới avatar/tên hiển thị tài khoản. | Nên có |
| FR-ACC-09 | Cấu hình **tự động xoá media cũ** theo số ngày cho từng tài khoản + chạy dọn định kỳ (cron 3h sáng). | Nên có |
| FR-ACC-10 | Lưu trữ credential (cookie) **mã hoá** bằng `safeStorage` (OS keychain). | Bắt buộc |

---

## 5. Yêu cầu chức năng — Nhắn tin (Chat)

| ID | Yêu cầu | Ưu tiên |
|---|---|---|
| FR-MSG-01 | Danh sách hội thoại (bạn bè, nhóm, người lạ) theo từng tài khoản; đếm chưa đọc. | Bắt buộc |
| FR-MSG-02 | Gửi **text, ảnh (đơn/nhiều), file, sticker, voice, video, link, card, bank card**. | Bắt buộc |
| FR-MSG-03 | **Thu hồi**, **xoá**, **chuyển tiếp**, **reaction** tin nhắn. | Bắt buộc |
| FR-MSG-04 | **Poll**: tạo, xem chi tiết, vote, thêm lựa chọn, khoá. | Nên có |
| FR-MSG-05 | Ghim tin nhắn / ghim hội thoại (local), đánh dấu chưa đọc, mute. | Nên có |
| FR-MSG-06 | **Tin nhắn nhanh (Quick Message)**: lưu mẫu theo từ khoá, chèn nhanh; clone giữa các tài khoản. | Nên có |
| FR-MSG-07 | **Nhãn hội thoại**: gán nhãn Zalo (đồng bộ 2 chiều với app Zalo) + nhãn local (màu/emoji tuỳ biến). | Bắt buộc |
| FR-MSG-08 | **Nháp tin (draft)** theo hội thoại; tự lưu, tự dọn nháp cũ. | Nên có |
| FR-MSG-09 | Tải **tin nhắn cũ** theo phiên đăng nhập; tin xuất hiện dần. | Nên có |
| FR-MSG-10 | Thông tin hội thoại/nhóm: thành viên, media, link, ghim; quản lý nhóm (thêm/xoá thành viên, đổi tên/avatar, phân quyền, link mời…). | Bắt buộc |
| FR-MSG-11 | **Tìm kiếm** tin nhắn & liên hệ (global + trong hội thoại). | Nên có |
| FR-MSG-12 | **Sticker**: tải, cache, sticker gần đây, gợi ý theo từ khoá. | Nên có |
| FR-MSG-13 | **Chế độ gộp hộp thư (Merged Inbox)**: xem tin nhắn nhiều tài khoản chung, lọc theo account. | Nên có |
| FR-MSG-14 | Thông báo desktop + âm thanh + flash taskbar + badge số chưa đọc khi có tin mới. | Nên có |
| FR-MSG-15 | Kết bạn: gửi/chấp nhận/từ chối/thu hồi lời mời; danh sách gợi ý kết bạn; thông báo lời mời mới. | Bắt buộc |

---

## 6. Yêu cầu chức năng — CRM & Quản lý khách hàng

### 6.1. Danh bạ & phân loại
| ID | Yêu cầu | Ưu tiên |
|---|---|---|
| FR-CRM-01 | Xem toàn bộ liên hệ theo tài khoản: bạn bè, nhóm, người lạ (stranger). | Bắt buộc |
| FR-CRM-02 | Bộ lọc nâng cao: theo nhãn, loại liên hệ, trạng thái, thời gian; tìm theo SĐT. | Bắt buộc |
| FR-CRM-03 | Dashboard CRM: tổng liên hệ, số bạn bè, số ghi chú, thống kê nhãn. | Nên có |
| FR-CRM-04 | **Hệ thống nhãn kép**: nhãn Zalo (đồng bộ điện thoại) + nhãn Local (không giới hạn, tuỳ biến). | Bắt buộc |
| FR-CRM-05 | **Ghi chú nội bộ** cho từng liên hệ (khách không thấy); thêm/sửa/xoá, xem theo dòng thời gian. | Bắt buộc |

### 6.2. Chiến dịch nhắn tin hàng loạt
| ID | Yêu cầu | Ưu tiên |
|---|---|---|
| FR-CRM-06 | Tạo chiến dịch: chọn đối tượng theo nhãn/bộ lọc → soạn mẫu tin (hỗ trợ nhiều khối, chế độ ngẫu nhiên) → gửi. | Bắt buộc |
| FR-CRM-07 | Hỗ trợ **biến động** (chèn tên/SĐT… vào nội dung). | Nên có |
| FR-CRM-08 | Chiến dịch hỗ trợ: gửi tin, gửi kết bạn, mời vào nhóm; **fallback** tự chuyển sang gửi lời mời khi bị chặn nhắn. | Bắt buộc |
| FR-CRM-09 | **Theo dõi realtime**: đã gửi / thất bại / phản hồi; tạm dừng / tiếp tục / clone chiến dịch. | Bắt buộc |
| FR-CRM-10 | **Lịch sử gửi** chi tiết theo từng tin (trạng thái, thời gian). | Bắt buộc |
| FR-CRM-11 | Thống kê so sánh hiệu quả các chiến dịch (deliveryRate, replyRate…). | Nên có |

### 6.3. Cơ chế chống ban (Anti-ban) — BẮT BUỘC
| ID | Yêu cầu | Giá trị mặc định |
|---|---|---|
| FR-CRM-12 | **Token bucket** giới hạn tốc độ gửi mỗi tài khoản. | 60 tin/giờ (hồi 1 token/60s) |
| FR-CRM-13 | **Delay tối thiểu** tuyệt đối giữa 2 lần gửi. | 30 giây |
| FR-CRM-14 | **Jitter ngẫu nhiên** cộng vào delay để phá pattern thời gian. | ±10 giây |
| FR-CRM-15 | Người dùng cấu hình được: **delay giữa tin**, **giới hạn/ngày** (`daily_send_limit`), **giờ bắt đầu gửi** (`daily_start_time`). | delay 120s; limit 0 (∞); 08:00 |
| FR-CRM-16 | Đạt `daily_send_limit` → tự **pause** chiến dịch; trước `daily_start_time` → chờ. | — |
| FR-CRM-17 | Cảnh báo người dùng trên UI khi cấu hình rủi ro (delay quá ngắn / nội dung quá dài). | — |
| FR-CRM-18 | **[Cải tiến đề xuất]** Thêm giới hạn riêng cho **gửi kết bạn** (nguyên nhân ban #1) + cơ chế **warmup** cho tài khoản mới. | Backlog |
| FR-CRM-19 | **[Cải tiến đề xuất]** Persist token bucket qua các lần tắt/mở app để không reset bộ đếm ngày. | Backlog |

---

## 7. Yêu cầu chức năng — Hỗ trợ & Hệ thống

| ID | Yêu cầu | Ưu tiên |
|---|---|---|
| FR-SYS-01 | **Dashboard** tổng quan tài khoản & hoạt động. | Nên có |
| FR-SYS-02 | **Báo cáo (Analytics)**: tổng quan, tin nhắn, liên hệ, nhãn, chiến dịch (theo khoảng thời gian). | Nên có |
| FR-SYS-03 | **Cài đặt**: hội thoại, giao diện (theme, cỡ chữ), thông báo, tài khoản, proxy, bảo mật, workspace, lưu trữ, giới thiệu, changelog. | Bắt buộc |
| FR-SYS-04 | **Lock screen**: đặt mật khẩu, mở khoá (mật khẩu/biometric), recovery key, cooldown chống brute-force. | Nên có |
| FR-SYS-05 | **Multi-workspace (local)**: nhiều workspace với DB + thư mục media độc lập; chuyển đổi workspace. | Nên có |
| FR-SYS-06 | **Quản lý file/media**: lưu trữ, mở, lưu-as, screenshot, sửa ảnh hỏng, video thumbnail. | Bắt buộc |
| FR-SYS-07 | **Auto-update** qua `electron-updater` (kiểm tra khi khởi động + định kỳ). | Nên có |
| FR-SYS-08 | Hệ thống tray + thu nhỏ xuống tray + badge số chưa đọc. | Nên có |
| FR-SYS-09 | Deep-link protocol handler. | Tuỳ chọn |

---

## 8. Yêu cầu phi chức năng (Non-Functional)

| ID | Yêu cầu |
|---|---|
| NFR-01 | **Local-first**: mọi dữ liệu lưu trên máy người dùng; không bắt buộc backend đám mây; không telemetry gửi ra ngoài. |
| NFR-02 | **Bảo mật credential**: cookie/API key mã hoá bằng OS keychain (`safeStorage`); mật khẩu hash `bcrypt` (rounds=12). |
| NFR-03 | **Đa nền tảng**: Windows 10/11 (x64), macOS (arm64 + Intel), Linux (AppImage/deb). |
| NFR-04 | **Hiệu năng DB**: SQLite WAL mode, memory-mapped I/O; truy vấn bất đồng bộ. |
| NFR-05 | **Chống ban**: xem Mục 6.3 — token bucket + delay + jitter + proxy per-account luôn bật, không tắt được ở tầng gửi hàng loạt. |
| NFR-06 | **Bản production** dùng JS obfuscator (RC4 string + đổi tên biến) + strip console. |
| NFR-07 | **Ổn định**: có global error handler (uncaughtException) — log & không crash toàn app. |
| NFR-08 | **Riêng tư per-account**: mỗi tài khoản một IP proxy độc lập để tránh bị nhận diện cụm. |

---

## 9. Ràng buộc & Rủi ro

| ID | Nội dung |
|---|---|
| RISK-01 | Dùng thư viện `zca-js` (reverse-engineer API Zalo không chính thức) → **vi phạm ToS Zalo**, tài khoản có thể bị **khóa vĩnh viễn**. Khuyến nghị dùng tài khoản phụ. |
| RISK-02 | Gửi tin/kết bạn hàng loạt có thể vi phạm quy định chống tin nhắn rác (NĐ 91/2020). |
| RISK-03 | Xử lý danh bạ/SĐT/nội dung chat khách hàng thuộc phạm vi **NĐ 13/2023 về Bảo vệ dữ liệu cá nhân** — cần có sự đồng ý. |
| RISK-04 | Native module `better-sqlite3` phải build đúng ABI của Electron; cài đặt **không dùng** `--ignore-scripts`. |
| CONS-01 | Giấy phép gốc **MIT** — được fork/sửa/bán, nhưng phải giữ copyright notice trong `LICENSE`. |
| CONS-02 | App phụ thuộc phiên bản Zalo web/protocol; `zca-js` cần cập nhật khi Zalo đổi API. |

---

## 10. Backlog kỹ thuật

### Đã hoàn thành (2026-07-02)

| ID | Hạng mục | Kết quả |
|---|---|---|
| BUG-01 | Sửa lỗi `ipc.fb.refreshContactAvatar` bị kích hoạt nhầm cho tài khoản Zalo (regex `/^\d+$/` khớp cả ID Zalo). | Thu hẹp điều kiện chỉ còn `channel === 'facebook'` ở 6 file (ChatHeader, ConversationList, ChatWindow, GlobalSearchPanel). |
| TECH-03 | Xoá **bảng DB không dùng** (fb_*, erp_*, employees/employee_*, workflows, workflow_run_logs, integrations) + toàn bộ method/migration liên quan trong `DatabaseService.ts` (~1.850 dòng). | Xác minh không còn tham chiếu; `deleteAccountData()` đã được sửa để không vỡ khi xoá tài khoản. |
| TECH-04 | Gỡ dependency không dùng: `cloudflared`, `localtunnel`, `mqtt`, `googleapis`, `reactflow`, `nodemailer`, `otplib`, `bytenode`, `jsonwebtoken`, `xlsx`, `quill`, `react-quill-new`, `tough-cookie`, `axios-cookiejar-support`, `dompurify`. | Xác minh bằng grep import thực tế trước khi xoá khỏi `package.json`. |
| TECH-05 | Sửa **CI workflows**: bỏ bước `build:bridge-e2ee` + Go setup (build-all, build-ubuntu), xoá `deploy-landing.yml` (thư mục `landing/` không tồn tại), rebrand repo/tên release. | 4 workflow còn lại chạy được, không còn bước chết. |
| TECH-06 | **Rebrand** "Deplao" → "ZaloAuto": `main.ts` (app name, AUMID, tray, deep-link scheme `deplao://`→`zaloauto://`), `index.html`, `TopBar`, `Sidebar`, `Settings`, `LockScreen`, `Dashboard`, `UpdateNotification` (kèm sửa link tải macOS trỏ nhầm sang app gốc), `EmployeeLoginScreen`. | Hoàn thành phần code/UI hiển thị. **Còn lại**: `ChangelogSettings.tsx` (761 dòng, nhiều version log mô tả ERP/Workflow/POS đã xoá) và `IntroductionSettings.tsx` (43 chỗ) — nội dung marketing/lịch sử, cần quyết định sản phẩm (viết lại hay giữ nguyên như lịch sử), không sửa mù để tránh bịa nội dung sai. |
| — | Dọn dead code phát sinh trong lúc sửa: `Sidebar.tsx` (xoá `ToolsGuideModal`/`NavFlyout`/`NavIcon` không thể truy cập, 1021→388 dòng), `AnalyticsPage.tsx` (xoá `WorkflowTab`/`WorkflowData`), `AddAccountModal.tsx` (xoá `FacebookAccountLoginTab`/`FacebookCookieLoginTab`/`CookieGuidePopup` + ảnh hướng dẫn 2MB `hd_login_fb_cookie.png`). | Giảm bundle JS ~40KB + 2MB ảnh. |
| TECH-09 | **Xoá hoàn toàn AI Assistant** (FR-AI-01…10, xem §2.2): trước đó tính năng không có đường vào từ Sidebar/App routing (`view === 'integration'` không được render ở đâu) và có bug DB (bảng `ai_assistants`/`ai_assistant_files` chưa từng được `CREATE TABLE`) — coi như chưa từng chạy được, quyết định gỡ bỏ thay vì nối lại dây. | Xoá 9 file UI/service (`AIAssistantPage/DetailPage`, `AIQuickPanel`, `PromptWizardModal`, `AccountAssignmentPopup`, `AIAssistantService`, `aiAssistantIpc`, `models/ai.ts`, `utils/aiUtils.ts`); dọn IPC (`electron/main.ts`, `preload.ts`, `crmIpc.ts`, `src/ui/lib/ipc.ts`); dọn 4 migration + `getAIAnalytics()` trong `DatabaseService.ts`; dọn state/action trong `appStore.ts`; gỡ nút/panel khỏi `ChatHeader.tsx`, `MessageInput.tsx` (kể cả phím tắt `Ctrl+S` treo), `App.tsx`, `ChatWindow.tsx`, `useZaloEvents.ts`, `index.css`; gỡ tab AI khỏi `AnalyticsPage.tsx`; bỏ quyền `ai_assistant` khỏi `ALL_MODULES` (employee.ts); gỡ dependency `uuid`/`@types/uuid` không còn dùng. |

### Còn lại

| ID | Hạng mục | Ghi chú |
|---|---|---|
| TECH-01 | **Purge sâu** code Facebook dormant còn lại trong UI chat (các cuộc gọi `ipc.fb?.` khác ngoài `refreshContactAvatar`, `fbInitUtils.ts`, namespace `fb`/`erp`/`workflow`/`employee`/`relay`/`sync`/`integration`/`tunnel` trong `preload.ts`). | Bug cụ thể đã sửa (xem BUG-01); phần còn lại là dead-nhưng-an-toàn, rủi ro cao hơn nếu purge vội vì đan vào chat UI (~150+ tham chiếu). |
| TECH-02 | Gỡ **workspace/employee dormant** trong shell (WorkspaceSettings, EmployeeConnectionBanner, employeeStore, EmployeeLoginScreen). | Đang để dormant để không vỡ vỏ App — cần plan riêng vì đan vào permission-gating của Sidebar/TopBar. |
| TECH-06b | Viết lại/xoá bớt `ChangelogSettings.tsx` và `IntroductionSettings.tsx` cho khớp tính năng thực tế của fork này. | Quyết định sản phẩm — xem ghi chú ở TECH-06 trên. Lưu ý: mọi nhắc tới AI/trợ lý AI trong 2 file này (nếu có) nay đã lỗi thời, cần dọn cùng lúc. |
| TECH-08 | Thực hiện các cải tiến chống ban FR-CRM-18, FR-CRM-19. | Nâng độ an toàn tài khoản. |

---

## 11. Tiêu chí nghiệm thu (Acceptance)

- [x] `npm install --legacy-peer-deps` chạy sạch (không `--ignore-scripts`).
- [x] `npm run build:electron` và `npm run build:renderer` (vite) build thành công.
- [x] `npm run dev` mở được cửa sổ app (xác minh trên máy thật — môi trường sandbox không có GUI để tự kiểm chứng).
- [ ] Đăng nhập được ≥1 tài khoản Zalo bằng QR và cookie.
- [ ] Gửi/nhận được tin nhắn text + ảnh.
- [ ] Tạo được nhãn, ghi chú, và 1 chiến dịch gửi thử với anti-ban hoạt động (delay + limit).
- [ ] Không có request telemetry gửi ra ngoài (kiểm tra bằng network monitor).

---

## Phụ lục A — Bảng dữ liệu chính (SQLite) được giữ

**Zalo core:** `accounts`, `messages`, `contacts`, `friends`, `links`, `page_group_member`, `stickers`, `sticker_packs`, `recent_stickers`, `keyword_stickers`, `pinned_messages`, `friend_requests`, `message_drafts`, `bank_cards`, `local_quick_messages`, `local_pinned_conversations`, `local_labels`, `local_label_threads`.

**CRM:** `crm_tags`, `crm_contact_tags`, `crm_notes`, `crm_campaigns`, `crm_campaign_contacts`, `crm_send_log`.

**Khác:** `proxies` (+ per-account settings).

## Phụ lục B — Lệnh vận hành

```bash
# Cài đặt (bắt buộc KHÔNG dùng --ignore-scripts)
npm install --legacy-peer-deps

# Chạy dev
npm run dev

# Build renderer / electron riêng
npm run build:renderer
npm run build:electron

# Đóng gói cài đặt (Windows .exe, …)
npm run production
```
