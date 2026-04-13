# FisherMen Chatbot

AI-powered chatbot for Bangladeshi fishermen using **Neo4j knowledge graph** + **Ollama LLM** (local/privacy-focused).

## Features
- Bengali/English chat with RAG (Retrieval-Augmented Generation)
- Chat history + search/export
- Dark mode toggle
- Admin feedback dashboard
- Secure config (.env)

## Quick Setup
```bash
pip install -r requirements.txt  
start neo4j instance
ollama serve         
ollama pull gemma3:1b
uvicorn server:app --reload
Open index.html in browser


## Architecture
Fisherman Query → FastAPI → Neo4j RAG → Ollama → Bengali Reply
