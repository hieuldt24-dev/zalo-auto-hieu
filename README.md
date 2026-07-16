# ZaloAuto Builder

Ứng dụng desktop (Windows/macOS/Linux) quản lý **đa tài khoản Zalo** tập trong trong một giao diện duy nhất, phục vụ đội nhóm bán hàng, chăm sóc khách hàng và marketing. Toàn bộ dữ liệu lưu **local-first** trên máy người dùng, không có backend đám mây bắt buộc, không gửi telemetry ra ngoài.

> Bản fork tối giản từ `deplao-builder` (MIT License), chỉ giữ 2 nhóm chức năng cốt lõi: **Nhắn tin đa tài khoản Zalo** và **CRM & Quản lý khách hàng**. Chi tiết đặc tả đầy đủ xem tại [REQUIREMENTS.md](REQUIREMENTS.md).

## Tính năng chính

- **Quản lý đa tài khoản Zalo**: đăng nhập bằng QR hoặc cookie, gắn proxy riêng (HTTP/HTTPS/SOCKS4/SOCKS5) cho từng tài khoản, tự kết nối lại, health check định kỳ.
- **Nhắn tin đầy đủ định dạng**: text, ảnh, file, sticker, voice, video, poll, thu hồi/xoá/chuyển tiếp/reaction, nhãn hội thoại, tin nhắn nhanh, merged inbox nhiều tài khoản.
- **CRM nhẹ**: danh bạ, nhãn kép (Zalo + local), ghi chú nội bộ, chiến dịch nhắn tin hàng loạt có kiểm soát (fallback gửi kết bạn, theo dõi realtime, lịch sử gửi).
- **Cơ chế chống ban**: token bucket, delay tối thiểu + jitter ngẫu nhiên, giới hạn gửi theo ngày, proxy per-account bắt buộc ở tầng gửi hàng loạt.
- **Hệ thống**: Dashboard, Báo cáo/Analytics, Lock screen, Multi-workspace local, quản lý file/media, auto-update.

## Công nghệ

| Lớp | Công nghệ |
|---|---|
| Desktop framework | Electron 41 |
| Ngôn ngữ | TypeScript 5 |
| Frontend | React 18, Vite 6, Tailwind CSS 3, Zustand 5 |
| Database | SQLite qua `better-sqlite3` (WAL mode) |
| Zalo API | `zca-js` |
| Đóng gói | `electron-builder` |

## Yêu cầu môi trường

- Node.js 18+ và npm
- Windows 10/11 (x64), macOS (arm64/Intel) hoặc Linux — có thể build native module `better-sqlite3` đúng ABI Electron

## Cài đặt

```bash
git clone <repo-url>
cd zalo-auto-builder
npm install --legacy-peer-deps
```

> ⚠️ **Không** dùng `--ignore-scripts` khi cài đặt — script `postinstall` cần chạy để patch icon Electron.

## Chạy dự án

### Chế độ phát triển (dev)

```bash
npm run dev
```

Lệnh này sẽ đồng thời: build electron (watch mode), chạy Vite dev server và mở cửa sổ Electron khi renderer sẵn sàng.

### Build từng phần

```bash
npm run build:renderer   # build giao diện (Vite) -> dist/
npm run build:electron   # build main/preload process (tsc) -> dist-electron/
```

### Đóng gói bản cài đặt (production)

```bash
npm run production
```

Lệnh này build bản production (kèm strip console + obfuscate), sau đó đóng gói bằng `electron-builder`. File cài đặt xuất ra tại `dist-electron-build/` (ví dụ `.exe` cho Windows).

## Cấu trúc thư mục chính

```
electron/            # main process: vòng đời app, cửa sổ, tray, đăng ký IPC
  main.ts
  preload.ts
  ipc/                # loginIpc, zaloIpc, crmIpc, databaseIpc, fileIpc, proxyIpc, workspaceIpc...
src/
  services/           # crm, database, event, file, http, login, secure, zalo
  models/             # kiểu dữ liệu (account, message, contact, crm, proxy...)
  utils/              # ConnectionManager, WorkspaceManager, ZaloLoginHelper, ProxyHelper...
  ui/
    App.tsx           # shell, routing
    lib/ipc.ts        # wrapper typed quanh window.electronAPI
    store/            # accountStore, chatStore, crmStore, appStore...
    components/       # auth, chat, crm, dashboard, analytics, settings, layout, common
```

## Lưu ý & rủi ro

- `zca-js` là thư viện reverse-engineer API Zalo không chính thức → vi phạm ToS Zalo, tài khoản có thể bị khoá vĩnh viễn. Khuyến nghị dùng tài khoản phụ để thử nghiệm.
- Gửi tin/kết bạn hàng loạt cần tuân thủ quy định chống tin nhắn rác và bảo vệ dữ liệu cá nhân hiện hành.
- Dữ liệu danh bạ/tin nhắn được lưu local trên máy; không có tính năng gửi dữ liệu về server bên ngoài.

Xem đầy đủ đặc tả chức năng, kiến trúc, backlog kỹ thuật tại [REQUIREMENTS.md](REQUIREMENTS.md).

## Giấy phép

[MIT](LICENSE)
