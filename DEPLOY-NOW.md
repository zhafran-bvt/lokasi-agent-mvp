# 🚀 Surge.sh Deployment — Quick Start

## ✅ Your Report is Ready to Deploy!

**What's prepared:**
- ✅ Build complete: `dist/` folder created (9.6 MB)
- ✅ HTML report generated: `dist/index.html` (18 KB)
- ✅ Screenshots copied: 33 images in `dist/screenshots/`
- ✅ Paths rewritten: All relative links working
- ✅ Surge CLI installed globally

---

## 🎯 Next: Choose Your Deployment Method

### Option 1: One-Command Deploy (Recommended)

```bash
cd /Users/bvt-zhafran/Downloads/lokasi-agent-mvp
npm run deploy
```

This will:
1. Prompt for your Surge.sh email (if first time)
2. Prompt for password
3. Auto-generate a domain like `{random-word}-{random-word}.surge.sh`
4. Deploy and show your public URL

**First time?** Surge will create your account automatically.

---

### Option 2: Deploy with Custom Domain

```bash
npm run deploy -- lokasi-regression-reports.surge.sh
```

Replaces `lokasi-regression-reports` with your preferred name (must be available).

---

### Option 3: Manual Deploy (if needed)

```bash
surge dist/
```

Then follow the interactive prompts.

---

## 📝 What Happens Interactively

When you run any deploy command, Surge will ask:

```
   project path: dist/
   domain: [leave blank for auto]
   email: your-email@example.com [create account if first time]
   password: ••••••••
   
   Surge deployed! ✨
   
   Project URL: https://your-domain.surge.sh
```

Save your credentials — next deploy will use them automatically.

---

## 🌐 After Deployment

You'll get a **public URL** like:
```
https://lokasi-regression-reports.surge.sh
```

**Share it with:**
- Team members (no login needed)
- Stakeholders
- Documentation
- CI/CD logs

---

## 📋 Verification Checklist

After deployment:
- [ ] URL is accessible in browser
- [ ] Report displays correctly
- [ ] Screenshots load (don't see broken image icons)
- [ ] Tables and formatting look good
- [ ] Can scroll through full report

---

## 💡 Tips

**Update report:**
```bash
npm run regression    # Run new regression
npm run deploy        # Deploy updated report
```

**Multiple runs:**
```bash
# Save different runs to different domains
npm run deploy -- lokasi-reports-run1.surge.sh
npm run deploy -- lokasi-reports-run2.surge.sh
```

**Delete old deploy:**
```bash
surge list            # See all your projects
surge teardown lokasi-regression-reports.surge.sh
```

---

## ❓ Troubleshooting

**"surge command not found"**
```bash
npm install -g surge
```

**"Domain already taken"**
- Try a different domain name with `npm run deploy -- your-unique-name.surge.sh`

**"Build failed"**
- Ensure you've run a regression: `npm run regression`
- Check `data/reports/` has a `.md` file

**Authentication issues**
```bash
surge logout
# Then try again, you'll be prompted to create account
```

---

## 🎉 Ready to Deploy?

Run this now:
```bash
cd /Users/bvt-zhafran/Downloads/lokasi-agent-mvp
npm run deploy
```

Then share your Surge URL with the team! 🚀
