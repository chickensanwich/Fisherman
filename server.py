from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel
from neo4j import GraphDatabase
from deep_translator import GoogleTranslator
import requests
import langdetect
import os
import json
import re
import hashlib
from datetime import datetime, timezone
from pathlib import Path
from dotenv import load_dotenv
load_dotenv()

app = FastAPI()

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

OLLAMA_URL = "http://localhost:11434/api/chat"
MODEL_NAME = "gemma3:1b"


NEO4J_URI = "bolt://localhost:7687"
NEO4J_USER = "neo4j"
NEO4J_PASSWORD = os.getenv("NEO4J_PASSWORD", "nej4nej4")


driver = GraphDatabase.driver(NEO4J_URI, auth=(NEO4J_USER, NEO4J_PASSWORD))
conversation_history = []

USERS_FILE = Path("users.json")
FEEDBACKS_FILE = Path("feedbacks.json")


def _load_users() -> list:
    if not USERS_FILE.exists():
        return []
    return json.loads(USERS_FILE.read_text(encoding="utf-8"))


def _save_users(users: list) -> None:
    USERS_FILE.write_text(json.dumps(users, indent=2), encoding="utf-8")


def _load_feedbacks() -> list:
    if not FEEDBACKS_FILE.exists():
        return []
    return json.loads(FEEDBACKS_FILE.read_text(encoding="utf-8"))


def _save_feedbacks(feedbacks: list) -> None:
    FEEDBACKS_FILE.write_text(json.dumps(feedbacks, indent=2), encoding="utf-8")


def _hash_password(password: str) -> str:
    return hashlib.sha256(password.encode()).hexdigest()


def _validate_identifier(name: str) -> str:
    """Only allow alphanumeric/underscore Neo4j labels and relationship types."""
    if not re.match(r'^[A-Za-z_][A-Za-z0-9_]*$', name):
        raise HTTPException(status_code=400, detail=f"Invalid identifier '{name}': use letters, digits, underscores only.")
    return name


def _get_element_id(entity) -> str:
    if hasattr(entity, 'element_id'):
        return entity.element_id
    return str(entity.id)


class ChatRequest(BaseModel):
    message: str

class FeedbackRequest(BaseModel):
    type: str
    reason: str = ""
    comments: str = ""
    message: str = ""
    userQuestion: str = ""

class SignupRequest(BaseModel):
    name: str
    fishermanId: str
    country: str
    location: str
    password: str

class LoginRequest(BaseModel):
    fishermanId: str
    password: str

class CreateNodeRequest(BaseModel):
    label: str
    properties: dict = {}

class UpdateNodeRequest(BaseModel):
    node_id: str
    properties: dict

class CreateRelationshipRequest(BaseModel):
    from_id: str
    to_id: str
    rel_type: str
    properties: dict = {}


# --- Language Detection ---
def detect_language(text: str) -> str:
    try:
        return langdetect.detect(text)  # returns "bn" for Bangla, "en" for English, etc.
    except Exception:
        return "en"  # default to English if detection fails


# --- Translation Helpers ---
def translate(text: str, source: str, target: str) -> str:
    try:
        return GoogleTranslator(source=source, target=target).translate(text)
    except Exception as e:
        print(f"[TRANSLATION ERROR] {e}")
        return text  # fallback: return original if translation fails


# --- Neo4j RAG Query (unchanged, operates in English) ---
def query_knowledge_graph(english_message: str) -> str:
    keywords = [word for word in english_message.lower().split() if len(word) > 3]
    context_parts = []

    with driver.session() as session:
        for keyword in keywords[:5]:
            result = session.run(
                """
                MATCH (n)
                WHERE any(prop in keys(n) WHERE toLower(toString(n[prop])) CONTAINS $keyword)
                OPTIONAL MATCH (n)-[r]->(m)
                RETURN n, type(r) as rel_type, m
                LIMIT 5
                """,
                keyword=keyword
            )
            for record in result:
                node = dict(record["n"])
                rel = record["rel_type"]
                related = dict(record["m"]) if record["m"] else None
                if rel and related:
                    context_parts.append(f"{node} --[{rel}]--> {related}")
                else:
                    context_parts.append(str(node))

    if not context_parts:
        return ""
    return "Relevant knowledge graph context:\n" + "\n".join(context_parts)


@app.post("/chat")
async def chat(request: ChatRequest):
    user_message = request.message

    detected_lang = detect_language(user_message)
    is_bangla = detected_lang == "bn"

    english_message = translate(user_message, source="bn", target="en") if is_bangla else user_message
    print(f"[LANG] detected={detected_lang}, translated_query={english_message}")

    kg_context = query_knowledge_graph(english_message)

    # If nothing found in the graph, return immediately — don't ask the LLM
    if not kg_context:
        no_info_reply = (
            "দুঃখিত, এই বিষয়ে আমার কাছে কোনো তথ্য নেই।"  # "Sorry, I have no information on this topic."
            if is_bangla else
            "Sorry, I don't have information on that topic in my knowledge base."
        )
        return {"reply": no_info_reply}

    language_instruction = (
        "You MUST reply in Bangla script only. Do not use English in your response."
        if is_bangla else
        "Reply in English."
    )

    augmented_message = f"{kg_context}\n\nUser question: {english_message}"

    conversation_history.append({
        "role": "user",
        "content": augmented_message
    })

    try:
        response = requests.post(OLLAMA_URL, json={
            "model": MODEL_NAME,
            "messages": [
                {
                    "role": "system",
                    "content": (
                        f"You are an assistant for Bangladeshi fishermen. "
                        f"You MUST answer ONLY using the knowledge graph context provided in the user message. "
                        f"Do NOT use any outside knowledge or make assumptions beyond what is explicitly in the context. "
                        f"If the context does not contain enough information to answer, say you don't know. "
                        f"{language_instruction}"
                    )
                },
                *conversation_history
            ],
            "stream": False
        })
        response.raise_for_status()
        data = response.json()
        reply = data["message"]["content"]
        
        if is_bangla:
            reply = translate(reply, source="en", target="bn")

        conversation_history.append({"role": "assistant", "content": reply})
        return {"reply": reply}

    except requests.exceptions.ConnectionError:
        raise HTTPException(status_code=503, detail="Ollama is not running.")
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@app.post("/signup")
async def signup(request: SignupRequest):
    users = _load_users()
    if any(u["fishermanId"] == request.fishermanId for u in users):
        raise HTTPException(status_code=409, detail="Fisherman ID already registered.")
    users.append({
        "fishermanId": request.fishermanId,
        "name": request.name,
        "country": request.country,
        "location": request.location,
        "password_hash": _hash_password(request.password),
        "status": "pending",
        "created_at": datetime.now(timezone.utc).isoformat(),
    })
    _save_users(users)
    return {"status": "pending", "message": "Account submitted for approval. Please wait for admin review."}


@app.post("/login")
async def login(request: LoginRequest):
    users = _load_users()
    user = next((u for u in users if u["fishermanId"] == request.fishermanId), None)
    if not user or user["password_hash"] != _hash_password(request.password):
        raise HTTPException(status_code=401, detail="Invalid Fisherman ID or password.")
    if user["status"] == "pending":
        raise HTTPException(status_code=403, detail="Your account is pending admin approval.")
    if user["status"] == "rejected":
        raise HTTPException(status_code=403, detail="Your account has been rejected. Please contact support.")
    return {
        "status": "approved",
        "name": user["name"],
        "fishermanId": user["fishermanId"],
        "country": user["country"],
        "location": user["location"],
    }


@app.get("/admin/pending-users")
async def get_pending_users():
    users = _load_users()
    pending = [
        {k: v for k, v in u.items() if k != "password_hash"}
        for u in users if u["status"] == "pending"
    ]
    return pending


@app.post("/admin/approve/{fisherman_id}")
async def approve_user(fisherman_id: str):
    users = _load_users()
    user = next((u for u in users if u["fishermanId"] == fisherman_id), None)
    if not user:
        raise HTTPException(status_code=404, detail="User not found.")
    user["status"] = "approved"
    _save_users(users)
    return {"status": "approved", "fishermanId": fisherman_id}


@app.post("/admin/reject/{fisherman_id}")
async def reject_user(fisherman_id: str):
    users = _load_users()
    user = next((u for u in users if u["fishermanId"] == fisherman_id), None)
    if not user:
        raise HTTPException(status_code=404, detail="User not found.")
    user["status"] = "rejected"
    _save_users(users)
    return {"status": "rejected", "fishermanId": fisherman_id}


@app.post("/feedback")
async def feedback(request: FeedbackRequest):
    feedbacks = _load_feedbacks()
    feedbacks.append({
        "type": request.type,
        "reason": request.reason,
        "comments": request.comments,
        "message": request.message,
        "userQuestion": request.userQuestion,
        "timestamp": datetime.now(timezone.utc).isoformat(),
    })
    _save_feedbacks(feedbacks)
    print(f"[FEEDBACK] type={request.type}, reason={request.reason}, message={request.message}")
    return {"status": "ok"}


@app.get("/admin/graph/search")
async def search_graph_nodes(q: str = ""):
    results = []
    with driver.session() as session:
        keywords = [w for w in q.lower().split() if len(w) > 2] if q.strip() else [""]
        seen = set()
        for keyword in keywords[:5]:
            cypher = (
                "MATCH (n) WHERE any(prop in keys(n) WHERE toLower(toString(n[prop])) CONTAINS $kw) "
                "OPTIONAL MATCH (n)-[r]->(m) "
                "RETURN n, collect({relId: elementId(r), type: type(r), targetId: elementId(m), targetProps: properties(m)}) as rels "
                "LIMIT 20"
            ) if keyword else (
                "MATCH (n) OPTIONAL MATCH (n)-[r]->(m) "
                "RETURN n, collect({relId: elementId(r), type: type(r), targetId: elementId(m), targetProps: properties(m)}) as rels "
                "LIMIT 20"
            )
            rows = session.run(cypher, kw=keyword)
            for record in rows:
                node = record["n"]
                nid = _get_element_id(node)
                if nid in seen:
                    continue
                seen.add(nid)
                rels = [
                    r for r in record["rels"]
                    if r.get("type") is not None
                ]
                results.append({
                    "nodeId": nid,
                    "labels": list(node.labels),
                    "properties": dict(node),
                    "relationships": [
                        {
                            "relId": r["relId"],
                            "type": r["type"],
                            "targetId": r["targetId"],
                            "targetProps": dict(r["targetProps"]) if r["targetProps"] else {},
                        }
                        for r in rels
                    ],
                })
    return results


@app.post("/admin/graph/node")
async def create_graph_node(request: CreateNodeRequest):
    label = _validate_identifier(request.label)
    with driver.session() as session:
        result = session.run(
            f"CREATE (n:{label} $props) RETURN elementId(n) as nodeId",
            props=request.properties,
        )
        record = result.single()
        return {"nodeId": record["nodeId"]}


@app.put("/admin/graph/node")
async def update_graph_node(request: UpdateNodeRequest):
    with driver.session() as session:
        result = session.run(
            "MATCH (n) WHERE elementId(n) = $nid SET n += $props RETURN elementId(n) as nodeId",
            nid=request.node_id,
            props=request.properties,
        )
        if not result.single():
            raise HTTPException(status_code=404, detail="Node not found.")
    return {"status": "updated"}


@app.delete("/admin/graph/node")
async def delete_graph_node(node_id: str):
    with driver.session() as session:
        session.run(
            "MATCH (n) WHERE elementId(n) = $nid DETACH DELETE n",
            nid=node_id,
        )
    return {"status": "deleted"}


@app.post("/admin/graph/relationship")
async def create_graph_relationship(request: CreateRelationshipRequest):
    rel_type = _validate_identifier(request.rel_type)
    with driver.session() as session:
        result = session.run(
            f"MATCH (a), (b) WHERE elementId(a) = $from_id AND elementId(b) = $to_id "
            f"CREATE (a)-[r:{rel_type} $props]->(b) RETURN elementId(r) as relId",
            from_id=request.from_id,
            to_id=request.to_id,
            props=request.properties,
        )
        record = result.single()
        if not record:
            raise HTTPException(status_code=404, detail="One or both nodes not found.")
        return {"relId": record["relId"]}


@app.delete("/admin/graph/relationship")
async def delete_graph_relationship(rel_id: str):
    with driver.session() as session:
        session.run(
            "MATCH ()-[r]-() WHERE elementId(r) = $rid DELETE r",
            rid=rel_id,
        )
    return {"status": "deleted"}


@app.get("/feedbacks")
async def get_feedbacks():
    return _load_feedbacks()


@app.on_event("shutdown")
def shutdown():
    driver.close()
