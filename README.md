# 📄 paperless-jo

[![GitHub commit activity](https://img.shields.io/github/commit-activity/t/TiefSeeTaucher69/paperless-jo)](https://github.com/TiefSeeTaucher69/paperless-jo/commits/main)
[![GitHub Stars](https://img.shields.io/github/stars/TiefSeeTaucher69/paperless-jo)](https://github.com/TiefSeeTaucher69/paperless-jo)
[![License](https://img.shields.io/github/license/TiefSeeTaucher69/paperless-jo?cacheSeconds=1)](LICENSE)

# 🍴 Fork Notice

**paperless-jo** is a personal fork of [Paperless-AI](https://github.com/clusterzx/paperless-ai) by [clusterzx](https://github.com/clusterzx), MIT-licensed. The upstream project is currently unmaintained while its author works on a full rewrite of unclear continuation, so this fork exists to keep evolving the current codebase for a self-hosted homelab setup (Paperless-ngx + local Ollama).

Everything below describes the underlying Paperless-AI project and mostly still applies here; sections specific to the original maintainer's infrastructure (Docker Hub releases, Discord, donations) have been adjusted or removed for this fork.

---

**Paperless-AI** is an AI-powered extension for [Paperless-ngx](https://github.com/paperless-ngx/paperless-ngx) that brings automatic document classification, smart tagging, and semantic search using OpenAI-compatible APIs and Ollama.

It enables **fully automated document workflows**, **contextual chat**, and **powerful customization** — all via an intuitive web interface.

> 💡 Just ask:  
> “When did I sign my rental agreement?”  
> “What was the amount of the last electricity bill?”  
> “Which documents mention my health insurance?”  

Powered by **Retrieval-Augmented Generation (RAG)**, you can now search semantically across your full archive and get precise, natural language answers.

---

## ✨ Features

### 🔄 Automated Document Processing
- Detects new documents in Paperless-ngx automatically
- Analyzes content using OpenAI API, Ollama, and other compatible backends
- Assigns title, tags, document type, and correspondent
- Built-in support for:
  - Ollama (Mistral, Llama, Phi-3, Gemma-2)
  - OpenAI
  - DeepSeek.ai
  - OpenRouter.ai
  - Perplexity.ai
  - Together.ai
  - LiteLLM
  - VLLM
  - Fastchat
  - Gemini (Google)
  - ...and more!

### 🧠 RAG-Based AI Chat
- Natural language document search and Q&A
- Understands full document context (not just keywords)
- Semantic memory powered by your own data
- Fast, intelligent, privacy-friendly document queries  
![RAG_CHAT_DEMO](https://raw.githubusercontent.com/clusterzx/paperless-ai/refs/heads/main/ppairag.png)

### ⚙️ Manual Processing
- Web interface for manual AI tagging
- Useful when reviewing sensitive documents
- Accessible via `/manual`

### 🧩 Smart Tagging & Rules
- Define rules to limit which documents are processed
- Disable prompts and apply tags automatically
- Set custom output tags for tracked classification  
![PPAI_SHOWCASE3](https://github.com/user-attachments/assets/1fc9f470-6e45-43e0-a212-b8fa6225e8dd)

### 🔍 Entity Resolution & Similarity Matching (Experimental)

Configurable from **Settings → Entity Resolution & Similarity Matching**:

- **EntityResolver** — fuzzy-matches AI-suggested tags/correspondents/document
  types against what already exists in Paperless-ngx (trigram similarity)
  instead of always creating a new entity. Tune the auto-merge and judge
  thresholds to your data before relying on it.
- **Embedding Similarity** — adds a second, semantic matching channel via an
  Ollama embedding model (`bge-m3` by default). Requires `ollama pull bge-m3`
  on the Ollama instance used by this app.
- **Document Fingerprint** — reuses a recurring document's tags/document type
  based on content similarity. **Not production-ready** (see the project's
  audit report, AUDIT-003) — leave disabled outside of testing.

Matches below the auto-merge threshold go to the in-app Review Queue
(`/review`) for manual confirmation instead of being applied automatically.

---

## 🚀 Installation

> ⚠️ **First-time install:** Restart the container **after completing setup** (API keys, preferences) to build RAG index.  
> 🔁 Not required for updates.

📘 [Installation Wiki](https://github.com/clusterzx/paperless-ai/wiki/2.-Installation)

---

## 🐳 Docker Support

- Health monitoring and auto-restart
- Persistent volumes and graceful shutdown
- Works out of the box with minimal setup

---

## 🔧 Local Development

```bash
# Install dependencies
npm install

# Start development/test mode
npm run test
```

---

## 🧭 Roadmap Highlights

- ✅ Multi-AI model support
- ✅ Multilingual document analysis
- ✅ Tag rules and filters
- ✅ Integrated document chat with RAG
- ✅ Responsive web interface

---

## 🤝 Contributing

We welcome PRs and contributions!

```bash
# Fork, clone, then:
git checkout -b feature/YourFeature
# After changes:
git commit -m "Add YourFeature"
git push origin feature/YourFeature
```

Then open a Pull Request via GitHub.

---

## 🆘 Support & Community

These are the upstream Paperless-AI project's channels, useful for questions about the underlying tool in general. For anything specific to this fork's changes, use [this repo's issues](https://github.com/TiefSeeTaucher69/paperless-jo/issues) instead.

- [Issues](https://github.com/clusterzx/paperless-ai/issues)
- [Discord](https://discord.gg/AvNekAfK38)

---

## 📄 License

This project is licensed under the MIT License. See [LICENSE](LICENSE) for details.

---

## 🙏 Credit

The vast majority of this codebase is [clusterzx](https://github.com/clusterzx)'s original work. If you'd like to support them, see the donation links on the [upstream repository](https://github.com/clusterzx/paperless-ai).
