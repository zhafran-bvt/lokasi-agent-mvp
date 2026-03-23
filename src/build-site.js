import fs from 'node:fs';
import path from 'node:path';
import { marked } from 'marked';
import { config } from './config.js';

function findLatestReport() {
  const reportsDir = path.join(config.dataDir, 'reports');
  if (!fs.existsSync(reportsDir)) return null;

  const reports = fs
    .readdirSync(reportsDir)
    .filter((f) => f.endsWith('.md'))
    .map((f) => ({
      name: f,
      path: path.join(reportsDir, f),
      time: fs.statSync(path.join(reportsDir, f)).mtimeMs,
    }))
    .sort((a, b) => b.time - a.time);

  return reports[0] || null;
}

function getRunIdFromReportFile(filename) {
  return filename.replace(/\.md$/, '');
}

function copyScreenshots(runId, destDir) {
  const srcDir = path.join(config.dataDir, 'screenshots', runId);
  const dstDir = path.join(destDir, 'screenshots', runId);

  if (!fs.existsSync(srcDir)) {
    console.log(`⚠️  No screenshots found at ${srcDir}`);
    return;
  }

  fs.mkdirSync(dstDir, { recursive: true });

  const files = fs.readdirSync(srcDir);
  for (const file of files) {
    const src = path.join(srcDir, file);
    const dst = path.join(dstDir, file);
    fs.copyFileSync(src, dst);
  }

  console.log(`✅ Copied ${files.length} screenshots to dist/screenshots/${runId}`);
}

function rewriteMarkdownPaths(markdown, runId) {
  // Replace absolute paths with relative paths
  const markdownWithRelativePaths = markdown.replace(
    /!\[([^\]]+)\]\([^)]+\/(data\/)?screenshots\/([^)]+)\)/g,
    (match, alt, _dataPrefix, filepath) => {
      // Extract just the path part after screenshots/
      return `![${alt}](screenshots/${filepath})`;
    }
  );
  return markdownWithRelativePaths;
}

function generateHtmlTemplate(htmlContent, title) {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${title}</title>
  <style>
    * {
      margin: 0;
      padding: 0;
      box-sizing: border-box;
    }
    
    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif;
      line-height: 1.6;
      color: #333;
      background: #fafbfc;
      padding: 20px;
    }
    
    .container {
      max-width: 1000px;
      margin: 0 auto;
      background: white;
      border-radius: 8px;
      box-shadow: 0 1px 3px rgba(0,0,0,0.1);
      padding: 40px;
    }
    
    h1 { 
      font-size: 2em; 
      margin: 30px 0 10px 0; 
      color: #000;
      border-bottom: 3px solid #0366d6;
      padding-bottom: 10px;
    }
    
    h2 { 
      font-size: 1.5em; 
      margin: 25px 0 15px 0; 
      color: #222;
      margin-top: 40px;
    }
    
    h3 { 
      font-size: 1.2em; 
      margin: 20px 0 10px 0; 
      color: #444;
    }
    
    h4, h5, h6 { 
      margin: 15px 0 8px 0; 
      color: #555;
    }
    
    p { 
      margin: 10px 0; 
    }
    
    table {
      width: 100%;
      border-collapse: collapse;
      margin: 15px 0;
      font-size: 0.95em;
    }
    
    table th, table td {
      padding: 12px;
      text-align: left;
      border-bottom: 1px solid #ddd;
    }
    
    table th {
      background: #f6f8fa;
      font-weight: 600;
      color: #24292e;
    }
    
    table tr:hover {
      background: #f6f8fa;
    }
    
    table code {
      background: #f1f3f5;
      padding: 2px 6px;
      border-radius: 3px;
      font-size: 0.9em;
    }
    
    ul, ol {
      margin: 15px 0 15px 30px;
    }
    
    li {
      margin: 5px 0;
    }
    
    code {
      background: #f1f3f5;
      padding: 3px 6px;
      border-radius: 3px;
      font-family: 'Courier New', monospace;
      font-size: 0.9em;
      color: #e83e8c;
    }
    
    pre {
      background: #f6f8fa;
      border: 1px solid #ddd;
      border-radius: 6px;
      padding: 16px;
      overflow-x: auto;
      margin: 15px 0;
    }
    
    pre code {
      background: none;
      padding: 0;
      color: #24292e;
    }
    
    blockquote {
      border-left: 4px solid #ddd;
      color: #666;
      margin: 15px 0;
      padding-left: 15px;
    }
    
    img {
      max-width: 100%;
      height: auto;
      border-radius: 6px;
      margin: 15px 0;
      border: 1px solid #ddd;
    }
    
    a {
      color: #0366d6;
      text-decoration: none;
    }
    
    a:hover {
      text-decoration: underline;
    }
    
    .header-meta {
      background: #f6f8fa;
      padding: 15px;
      border-radius: 6px;
      margin-bottom: 20px;
      font-size: 0.95em;
      color: #666;
    }
    
    .header-meta strong {
      color: #333;
    }
    
    /* Status indicators */
    .emoji {
      margin-right: 5px;
    }
    
    @media (max-width: 768px) {
      .container {
        padding: 20px;
      }
      
      table {
        font-size: 0.85em;
      }
      
      table th, table td {
        padding: 8px;
      }
    }
  </style>
</head>
<body>
  <div class="container">
    ${htmlContent}
  </div>
</body>
</html>`;
}

function buildSite() {
  console.log('🔨 Building deployable site...\n');

  const report = findLatestReport();
  if (!report) {
    console.error('❌ No report found in data/reports/');
    process.exit(1);
  }

  console.log(`📄 Using report: ${report.name}`);

  const runId = getRunIdFromReportFile(report.name);
  const distDir = path.resolve('./dist');

  // Clean and create dist
  if (fs.existsSync(distDir)) {
    fs.rmSync(distDir, { recursive: true });
  }
  fs.mkdirSync(distDir, { recursive: true });
  console.log(`📁 Created dist/ directory`);

  // Read and process markdown
  const markdownContent = fs.readFileSync(report.path, 'utf8');
  const rewrittenMarkdown = rewriteMarkdownPaths(markdownContent, runId);

  // Convert to HTML
  const htmlContent = marked(rewrittenMarkdown);

  // Extract title from first h1
  const titleMatch = markdownContent.match(/^# (.*?)$/m);
  const title = titleMatch ? titleMatch[1].replace(/^[📊🔄]\s*/, '') : 'Report';

  // Create HTML file
  const fullHtml = generateHtmlTemplate(htmlContent, title);
  fs.writeFileSync(path.join(distDir, 'index.html'), fullHtml);
  console.log(`✅ Generated index.html`);

  // Copy screenshots
  copyScreenshots(runId, distDir);

  // Create .surgeignore (optional, but good practice)
  const surgeignore = `node_modules
src
data
output
.env
.git`;
  fs.writeFileSync(path.join(distDir, '.surgeignore'), surgeignore);

  console.log(`
✨ Build complete!

Deployment instructions:
  npm run deploy                    (auto-generates and deploys to surge)
  npm run deploy -- my-domain.surge.sh  (deploy to custom domain)

Or:
  npm run build                     (just generate without deploying)
  surge dist/                        (deploy manually)
  surge dist/ --domain my-domain.surge.sh
`);
}

buildSite();
