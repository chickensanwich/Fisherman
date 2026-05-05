from fastapi import FastAPI, HTTPException, Header
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel
from motor.motor_asyncio import AsyncIOMotorClient
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
from bson import ObjectId
import asyncio
from fastapi import File, UploadFile
from google.cloud import speech as gcp_speech

load_dotenv()

app = FastAPI(title="FisherMen Chatbot API")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# ====================== CONFIG ======================
MONGODB_URL = "mongodb://localhost:27017"
OLLAMA_URL  = "http://localhost:11434/api/chat"
MODEL_NAME  = "gemma3:1b"

NEO4J_URI      = "bolt://localhost:7687"
NEO4J_USER     = "neo4j"
NEO4J_PASSWORD = os.getenv("NEO4J_PASSWORD", "nej4nej4")

# ====================== GOOGLE CLOUD SPEECH-TO-TEXT ======================
speech_client = gcp_speech.SpeechClient()

# ====================== DATABASES ======================
mongo_client     = AsyncIOMotorClient(MONGODB_URL)
db               = mongo_client["fishermen_chatbot"]
chats_collection = db["chats"]

neo4j_driver = GraphDatabase.driver(NEO4J_URI, auth=(NEO4J_USER, NEO4J_PASSWORD))

# ====================== JSON FILE STORAGE ======================
USERS_FILE     = Path("users.json")
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
    if not re.match(r'^[A-Za-z_][A-Za-z0-9_]*$', name):
        raise HTTPException(status_code=400, detail=f"Invalid identifier '{name}': use letters, digits, underscores only.")
    return name


def _get_element_id(entity) -> str:
    if hasattr(entity, 'element_id'):
        return entity.element_id
    return str(entity.id)


# ====================== AUTH DEPENDENCY ======================
async def require_approved_user(x_fisherman_id: str = Header(...)) -> str:
    users = _load_users()
    user  = next((u for u in users if u["fishermanId"] == x_fisherman_id), None)
    if not user:
        raise HTTPException(status_code=401, detail="Unknown Fisherman ID.")
    if user["status"] == "pending":
        raise HTTPException(status_code=403, detail="Account pending admin approval.")
    if user["status"] == "rejected":
        raise HTTPException(status_code=403, detail="Account rejected. Contact support.")
    return x_fisherman_id


# ====================== MODELS ======================
class ChatRequest(BaseModel):
    message: str
    chat_id: str

class SignupRequest(BaseModel):
    name: str
    fishermanId: str
    country: str
    location: str
    password: str

class LoginRequest(BaseModel):
    fishermanId: str
    password: str

class FeedbackRequest(BaseModel):
    type: str
    reason: str = ""
    comments: str = ""
    message: str = ""
    userQuestion: str = ""

class TitleUpdate(BaseModel):
    title: str

class PinUpdate(BaseModel):
    pinned: bool

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


# ====================== LANGUAGE & KNOWLEDGE GRAPH ======================
def detect_language(text: str) -> str:
    if not text or not text.strip():
        return "en"
    try:
        return langdetect.detect(text.strip())
    except Exception:
        return "en"


def translate(text: str, source: str, target: str) -> str:
    try:
        return GoogleTranslator(source=source, target=target).translate(text)
    except Exception as e:
        print(f"[TRANSLATION ERROR] {e}")
        return text


def query_knowledge_graph(english_message: str) -> str:
    keywords     = [word for word in english_message.lower().split() if len(word) > 3]
    context_parts = []

    with neo4j_driver.session() as session:
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
                node    = dict(record["n"])
                rel     = record.get("rel_type")
                related = dict(record["m"]) if record["m"] else None
                if rel and related:
                    context_parts.append(f"{node} --[{rel}]--> {related}")
                else:
                    context_parts.append(str(node))

    return "Relevant knowledge graph context:\n" + "\n".join(context_parts) if context_parts else ""


# ====================== AUTO-GENERATE CHAT TITLE ======================
async def generate_chat_title(user_message: str, bot_reply: str) -> str:
    try:
        prompt = f"""Generate a short, clear, and suitable title (maximum 6 words) for this chat.
Context: Bangladeshi fishermen chatbot.
User first message: {user_message}
Assistant reply: {bot_reply[:300]}

Title (only return the title, no explanation):"""

        response = requests.post(OLLAMA_URL, json={
            "model": MODEL_NAME,
            "messages": [{"role": "user", "content": prompt}],
            "stream": False
        }, timeout=12)
        response.raise_for_status()
        data  = response.json()
        title = ""
        if "message" in data and "content" in data["message"]:
            title = data["message"]["content"].strip()
        elif "response" in data:
            title = data["response"].strip()

        title = title.replace('"', '').replace("'", "").strip()
        if len(title) > 60:
            title = title[:57] + "..."
        if title:
            return title
    except Exception as e:
        print(f"Title generation failed: {e}")

    fallback = user_message.strip()[:50]
    return fallback + "..." if len(fallback) == 50 else fallback


# ====================== AUTH ENDPOINTS ======================
@app.post("/signup")
async def signup(request: SignupRequest):
    users = _load_users()
    if any(u["fishermanId"] == request.fishermanId for u in users):
        raise HTTPException(status_code=409, detail="Fisherman ID already registered.")
    users.append({
        "fishermanId":    request.fishermanId,
        "name":           request.name,
        "country":        request.country,
        "location":       request.location,
        "password_hash":  _hash_password(request.password),
        "status":         "pending",
        "created_at":     datetime.now(timezone.utc).isoformat(),
    })
    _save_users(users)
    return {"status": "pending", "message": "Account submitted for approval. Please wait for admin review."}


@app.post("/login")
async def login(request: LoginRequest):
    users = _load_users()
    user  = next((u for u in users if u["fishermanId"] == request.fishermanId), None)
    if not user or user["password_hash"] != _hash_password(request.password):
        raise HTTPException(status_code=401, detail="Invalid Fisherman ID or password.")
    if user["status"] == "pending":
        raise HTTPException(status_code=403, detail="Your account is pending admin approval.")
    if user["status"] == "rejected":
        raise HTTPException(status_code=403, detail="Your account has been rejected. Please contact support.")
    return {
        "status":      "approved",
        "name":        user["name"],
        "fishermanId": user["fishermanId"],
        "country":     user["country"],
        "location":    user["location"],
    }


# ====================== ADMIN USER MANAGEMENT ======================
@app.get("/admin/pending-users")
async def get_pending_users():
    users   = _load_users()
    pending = [
        {k: v for k, v in u.items() if k != "password_hash"}
        for u in users if u["status"] == "pending"
    ]
    return pending


@app.post("/admin/approve/{fisherman_id}")
async def approve_user(fisherman_id: str):
    users = _load_users()
    user  = next((u for u in users if u["fishermanId"] == fisherman_id), None)
    if not user:
        raise HTTPException(status_code=404, detail="User not found.")
    user["status"] = "approved"
    _save_users(users)
    return {"status": "approved", "fishermanId": fisherman_id}


@app.post("/admin/reject/{fisherman_id}")
async def reject_user(fisherman_id: str):
    users = _load_users()
    user  = next((u for u in users if u["fishermanId"] == fisherman_id), None)
    if not user:
        raise HTTPException(status_code=404, detail="User not found.")
    user["status"] = "rejected"
    _save_users(users)
    return {"status": "rejected", "fishermanId": fisherman_id}


# ====================== GOOGLE CLOUD SPEECH-TO-TEXT ======================
@app.post("/transcribe")
async def transcribe_audio(
    audio: UploadFile = File(...),
    x_fisherman_id: str = Header(...)
):
    await require_approved_user(x_fisherman_id)

    audio_content = await audio.read()
    content_type  = (audio.content_type or "audio/webm").lower()
    encoding = (
        gcp_speech.RecognitionConfig.AudioEncoding.OGG_OPUS
        if "ogg" in content_type
        else gcp_speech.RecognitionConfig.AudioEncoding.WEBM_OPUS
    )

    try:
        recognition_audio = gcp_speech.RecognitionAudio(content=audio_content)
        config = gcp_speech.RecognitionConfig(
            encoding=encoding,
            language_code="bn-BD",
            alternative_language_codes=["en-US"],
            enable_automatic_punctuation=True,
            model="latest_long",
        )
        response = await asyncio.to_thread(
            speech_client.recognize,
            config=config,
            audio=recognition_audio,
        )

        if not response.results:
            return {"text": "", "language": "en"}

        transcript = " ".join(
            result.alternatives[0].transcript
            for result in response.results
        )
        detected_lang_bcp47 = response.results[0].language_code
        lang = "bn" if detected_lang_bcp47.startswith("bn") else "en"
        return {"text": transcript.strip(), "language": lang}

    except Exception as e:
        print(f"Google Cloud STT error: {e}")
        raise HTTPException(status_code=500, detail=str(e))


# ====================== CHAT HISTORY ======================
@app.get("/chats")
async def get_user_chats(x_fisherman_id: str = Header(...)):
    await require_approved_user(x_fisherman_id)
    chats = await chats_collection.find(
        {"user_id": x_fisherman_id}
    ).sort([("pinned", -1), ("updated_at", -1)]).to_list(length=50)
    for chat in chats:
        chat["_id"] = str(chat["_id"])
    return chats


@app.post("/chats")
async def create_new_chat(x_fisherman_id: str = Header(...)):
    await require_approved_user(x_fisherman_id)
    chat_doc = {
        "user_id":    x_fisherman_id,
        "title":      "New Chat",
        "messages":   [],
        "pinned":     False,
        "created_at": datetime.utcnow(),
        "updated_at": datetime.utcnow(),
    }
    result = await chats_collection.insert_one(chat_doc)
    return {"chat_id": str(result.inserted_id), "title": "New Chat"}


@app.delete("/chats/{chat_id}")
async def delete_chat(chat_id: str, x_fisherman_id: str = Header(...)):
    await require_approved_user(x_fisherman_id)
    try:
        chat_id_obj = ObjectId(chat_id)
    except Exception:
        raise HTTPException(status_code=400, detail="Invalid chat_id format")

    chat = await chats_collection.find_one({"_id": chat_id_obj})
    if not chat:
        raise HTTPException(status_code=404, detail="Chat not found")
    if chat.get("user_id") != x_fisherman_id:
        raise HTTPException(status_code=403, detail="You do not have permission to delete this chat")

    result = await chats_collection.delete_one({"_id": chat_id_obj})
    if result.deleted_count == 0:
        raise HTTPException(status_code=404, detail="Failed to delete chat")
    return {"status": "deleted", "message": "Chat successfully deleted"}


@app.get("/chats/{chat_id}")
async def get_chat_by_id(chat_id: str, x_fisherman_id: str = Header(...)):
    await require_approved_user(x_fisherman_id)
    try:
        chat_id_obj = ObjectId(chat_id)
    except Exception:
        raise HTTPException(status_code=400, detail="Invalid chat_id format")

    chat = await chats_collection.find_one({"_id": chat_id_obj, "user_id": x_fisherman_id})
    if not chat:
        raise HTTPException(status_code=404, detail="Chat not found or no permission")
    chat["_id"] = str(chat["_id"])
    return chat


@app.put("/chats/{chat_id}/title")
async def update_chat_title(chat_id: str, body: TitleUpdate, x_fisherman_id: str = Header(...)):
    await require_approved_user(x_fisherman_id)
    try:
        chat_id_obj = ObjectId(chat_id)
    except Exception:
        raise HTTPException(status_code=400, detail="Invalid chat_id format")

    result = await chats_collection.update_one(
        {"_id": chat_id_obj, "user_id": x_fisherman_id},
        {"$set": {"title": body.title.strip() or "Untitled Chat"}}
    )
    if result.modified_count == 0:
        raise HTTPException(status_code=404, detail="Chat not found or no permission")
    return {"status": "success", "title": body.title}


@app.put("/chats/{chat_id}/pin")
async def toggle_pin_chat(chat_id: str, body: PinUpdate, x_fisherman_id: str = Header(...)):
    await require_approved_user(x_fisherman_id)
    try:
        chat_id_obj = ObjectId(chat_id)
    except Exception:
        raise HTTPException(status_code=400, detail="Invalid chat_id format")

    result = await chats_collection.update_one(
        {"_id": chat_id_obj, "user_id": x_fisherman_id},
        {"$set": {"pinned": body.pinned}}
    )
    if result.modified_count == 0:
        raise HTTPException(status_code=404, detail="Chat not found or no permission")
    return {"status": "success", "pinned": body.pinned}


# ====================== CHAT MESSAGE SAVING ======================
async def save_chat_message(fisherman_id: str, chat_id: str, user_message: str, bot_reply: str):
    try:
        chat_id_obj = ObjectId(chat_id)
    except Exception:
        raise HTTPException(status_code=400, detail="Invalid chat_id format")

    chat_obj = await chats_collection.find_one({"_id": chat_id_obj, "user_id": fisherman_id})
    if not chat_obj:
        raise HTTPException(status_code=404, detail="Chat not found")

    new_messages = [
        {"sender": "user", "content": user_message, "timestamp": datetime.utcnow()},
        {"sender": "bot",  "content": bot_reply,    "timestamp": datetime.utcnow()},
    ]
    await chats_collection.update_one(
        {"_id": chat_id_obj},
        {
            "$push": {"messages": {"$each": new_messages}},
            "$set":  {"updated_at": datetime.utcnow()},
        }
    )


# ====================== MAIN CHAT ENDPOINT ======================
@app.post("/chat")
async def chat_endpoint(request: ChatRequest, x_fisherman_id: str = Header(...)):
    fisherman_id  = await require_approved_user(x_fisherman_id)
    user_message  = request.message.strip()
    chat_id       = request.chat_id

    detected_lang   = detect_language(user_message)
    is_bangla       = detected_lang == "bn"
    english_message = translate(user_message, "bn", "en") if is_bangla else user_message

    kg_context = await asyncio.to_thread(query_knowledge_graph, english_message)

    if not kg_context:
        no_info_reply = (
            "দুঃখিত, এই বিষয়ে আমার কাছে কোনো তথ্য নেই।"
            if is_bangla else
            "Sorry, I don't have information on that topic in my knowledge base."
        )
        await save_chat_message(fisherman_id, chat_id, user_message, no_info_reply)
        return {"reply": no_info_reply}

    language_instruction = (
        "You MUST reply in Bangla script only. Do not use English in your response."
        if is_bangla else
        "Reply in English."
    )

    try:
        response = requests.post(OLLAMA_URL, json={
            "model": MODEL_NAME,
            "messages": [
                {
                    "role": "system",
                    "content": (
                        f"You are an assistant for Bangladeshi fishermen. "
                        f"You MUST answer ONLY using the knowledge graph context provided in the user message. "
                        f"Do NOT use any outside knowledge. If the context does not contain enough information, say you don't know. "
                        f"{language_instruction}"
                    )
                },
                {"role": "user", "content": f"{kg_context}\n\nUser question: {english_message}"}
            ],
            "stream": False
        }, timeout=60)
        response.raise_for_status()
        data = response.json()

        if "message" in data and "content" in data["message"]:
            reply = data["message"]["content"]
        elif "response" in data:
            reply = data["response"]
        else:
            reply = "Sorry, I couldn't generate a response."

        if is_bangla:
            reply = translate(reply, "en", "bn")

        await save_chat_message(fisherman_id, chat_id, user_message, reply)

        chat_obj = await chats_collection.find_one({"_id": ObjectId(chat_id)})
        if chat_obj and len(chat_obj.get("messages", [])) == 2:
            new_title = await generate_chat_title(user_message, reply)
            await chats_collection.update_one(
                {"_id": ObjectId(chat_id)},
                {"$set": {"title": new_title}}
            )

        return {"reply": reply}

    except requests.exceptions.ConnectionError:
        raise HTTPException(status_code=503, detail="Ollama is not running.")
    except Exception as e:
        error_reply = "দুঃখিত, সার্ভারে সমস্যা হয়েছে।" if is_bangla else "Sorry, something went wrong."
        await save_chat_message(fisherman_id, chat_id, user_message, error_reply)
        return {"reply": error_reply}


# ====================== FEEDBACK ======================
@app.post("/feedback")
async def feedback(request: FeedbackRequest, x_fisherman_id: str = Header(...)):
    await require_approved_user(x_fisherman_id)
    feedbacks = _load_feedbacks()
    feedbacks.append({
        "type":          request.type,
        "reason":        request.reason,
        "comments":      request.comments,
        "message":       request.message,
        "userQuestion":  request.userQuestion,
        "fishermanId":   x_fisherman_id,
        "timestamp":     datetime.now(timezone.utc).isoformat(),
    })
    _save_feedbacks(feedbacks)
    return {"status": "ok"}


@app.get("/feedbacks")
async def get_feedbacks():
    return _load_feedbacks()


# ====================== KNOWLEDGE GRAPH ADMIN ======================
@app.get("/admin/graph/search")
async def search_graph_nodes(q: str = ""):
    results = []
    with neo4j_driver.session() as session:
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
                nid  = _get_element_id(node)
                if nid in seen:
                    continue
                seen.add(nid)
                rels = [r for r in record["rels"] if r.get("type") is not None]
                results.append({
                    "nodeId":        nid,
                    "labels":        list(node.labels),
                    "properties":    dict(node),
                    "relationships": [
                        {
                            "relId":       r["relId"],
                            "type":        r["type"],
                            "targetId":    r["targetId"],
                            "targetProps": dict(r["targetProps"]) if r["targetProps"] else {},
                        }
                        for r in rels
                    ],
                })
    return results


@app.post("/admin/graph/node")
async def create_graph_node(request: CreateNodeRequest):
    label = _validate_identifier(request.label)
    with neo4j_driver.session() as session:
        result = session.run(
            f"CREATE (n:{label} $props) RETURN elementId(n) as nodeId",
            props=request.properties,
        )
        record = result.single()
        return {"nodeId": record["nodeId"]}


@app.put("/admin/graph/node")
async def update_graph_node(request: UpdateNodeRequest):
    with neo4j_driver.session() as session:
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
    with neo4j_driver.session() as session:
        session.run(
            "MATCH (n) WHERE elementId(n) = $nid DETACH DELETE n",
            nid=node_id,
        )
    return {"status": "deleted"}


@app.post("/admin/graph/relationship")
async def create_graph_relationship(request: CreateRelationshipRequest):
    rel_type = _validate_identifier(request.rel_type)
    with neo4j_driver.session() as session:
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
    with neo4j_driver.session() as session:
        session.run(
            "MATCH ()-[r]-() WHERE elementId(r) = $rid DELETE r",
            rid=rel_id,
        )
    return {"status": "deleted"}

# ====================== USER KNOWLEDGE GRAPH CONTRIBUTION ======================
class ContributeRequest(BaseModel):
    subject: str
    relation: str
    object_: str
    context: str = ""

CONTRIBUTIONS_FILE = Path("contributions.json")

def _load_contributions() -> list:
    if not CONTRIBUTIONS_FILE.exists():
        return []
    return json.loads(CONTRIBUTIONS_FILE.read_text(encoding="utf-8"))

def _save_contributions(contributions: list) -> None:
    CONTRIBUTIONS_FILE.write_text(json.dumps(contributions, indent=2), encoding="utf-8")


@app.post("/contribute")
async def contribute_knowledge(request: ContributeRequest, x_fisherman_id: str = Header(...)):
    await require_approved_user(x_fisherman_id)
    if not request.subject.strip() or not request.relation.strip() or not request.object_.strip():
        raise HTTPException(status_code=400, detail="Subject, relation, and object are required.")
    import time
    contributions = _load_contributions()
    contribution = {
        "id": f"contrib_{int(time.time() * 1000)}",
        "fishermanId": x_fisherman_id,
        "subject": request.subject.strip(),
        "relation": request.relation.strip().upper().replace(" ", "_"),
        "object": request.object_.strip(),
        "context": request.context.strip(),
        "status": "pending",
        "submitted_at": datetime.now(timezone.utc).isoformat(),
    }
    contributions.append(contribution)
    _save_contributions(contributions)
    return {"status": "pending", "message": "Thank you! Your contribution has been submitted for admin review."}


@app.get("/admin/contributions")
async def get_contributions(status: str = "pending"):
    contributions = _load_contributions()
    return [c for c in contributions if c.get("status") == status]


@app.post("/admin/contributions/review")
async def review_contribution(contribution_id: str, action: str):
    if action not in ("approve", "reject"):
        raise HTTPException(status_code=400, detail="action must be 'approve' or 'reject'.")
    contributions = _load_contributions()
    contribution = next((c for c in contributions if c["id"] == contribution_id), None)
    if not contribution:
        raise HTTPException(status_code=404, detail="Contribution not found.")

    if action == "approve":
        def to_label(s: str) -> str:
            clean = re.sub(r"[^A-Za-z0-9 ]", "", s).title().replace(" ", "_")
            return clean if re.match(r"^[A-Za-z_][A-Za-z0-9_]*$", clean) else "Entity"

        subj_label = to_label(contribution["subject"])
        obj_label  = to_label(contribution["object"])
        rel_type   = _validate_identifier(
            re.sub(r"[^A-Za-z0-9_]", "_", contribution["relation"])
        )
        with neo4j_driver.session() as session:
            session.run(
                f"""
                MERGE (a:{subj_label} {{name: $subj_name}})
                MERGE (b:{obj_label}  {{name: $obj_name}})
                MERGE (a)-[r:{rel_type}]->(b)
                ON CREATE SET r.context = $ctx,
                              r.contributed_by = $uid,
                              r.created_at = $ts
                """,
                subj_name=contribution["subject"],
                obj_name=contribution["object"],
                ctx=contribution.get("context", ""),
                uid=contribution["fishermanId"],
                ts=datetime.now(timezone.utc).isoformat(),
            )
        contribution["status"] = "approved"
    else:
        contribution["status"] = "rejected"

    _save_contributions(contributions)
    return {"status": contribution["status"], "contribution_id": contribution_id}

@app.on_event("shutdown")
async def shutdown():
    if neo4j_driver:
        neo4j_driver.close()
