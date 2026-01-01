# GitHub File Uploader (Any Repo • No Code Edit for Users)

User cukup isi di website:
- GitHub token
- owner/username
- repository
- ZIP

Lalu klik upload, dan file akan di-push ke repo tersebut (kalau token punya akses write).

## Run lokal
```bash
npm i
npm run dev
```

## Deploy ke Vercel
- Push folder ini ke GitHub
- Import project di Vercel
- Deploy (tanpa ENV)

## Catatan
- Upload dilakukan di browser memakai GitHub Contents API (per file).
- Token tidak disimpan.
