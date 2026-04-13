from fastapi import FastAPI, HTTPException, Depends, status
from fastapi.middleware.cors import CORSMiddleware
from fastapi.security import OAuth2PasswordBearer, OAuth2PasswordRequestForm
from pydantic import BaseModel
from motor.motor_asyncio import AsyncIOMotorClient
import bcrypt
from jose import JWTError, jwt
from datetime import datetime, timedelta
import os
from dotenv import load_dotenv
import asyncio
from fastapi import Path
# RAG + LLM imports
from neo4j import GraphDatabase
from deep_translator import GoogleTranslator
import requests
import langdetect
from bson import ObjectId

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
SECRET_KEY = "super-secret-key-change-this-in-production"
ALGORITHM = "HS256"
ACCESS_TOKEN_EXPIRE_MINUTES = 1440

OLLAMA_URL = "http://localhost:11434/api/chat"
MODEL_NAME = "gemma3:1b"

NEO4J_URI = "bolt://localhost:7687"
NEO4J_USER = "neo4j"
NEO4J_PASSWORD = os.getenv("NEO4J_PASSWORD", "nej4nej4")

# ====================== DATABASES ======================
client = AsyncIOMotorClient(MONGODB_URL)
db = client["fishermen_chatbot"]

users_collection = db["users"]
chats_collection = db["chats"]
feedbacks_collection = db["feedbacks"]

neo4j_driver = GraphDatabase.driver(NEO4J_URI, auth=(NEO4J_USER, NEO4J_PASSWORD))

# Security
oauth2_scheme = OAuth2PasswordBearer(tokenUrl="login")

# ====================== MODELS ======================
class ChatRequest(BaseModel):
    message: str
    chat_id: str                          # required, no default

class UserBase(BaseModel):
    name: str
    fisherman_id: str
    location: str = ""

class UserCreate(UserBase):
    password: str

class Token(BaseModel):
    access_token: str
    token_type: str = "bearer"

class FeedbackRequest(BaseModel):
    type: str
    reason: str = ""
    comments: str = ""
    message: str = ""
class TitleUpdate(BaseModel):
    title: str
class PinUpdate(BaseModel):
    pinned: bool    
    
# ====================== HELPERS ======================
def get_password_hash(password: str) -> str:
    salt = bcrypt.gensalt()
    hashed = bcrypt.hashpw(password.encode('utf-8'), salt)
    return hashed.decode('utf-8')

def verify_password(plain_password: str, hashed_password: str) -> bool:
    return bcrypt.checkpw(plain_password.encode('utf-8'), hashed_password.encode('utf-8'))

def create_access_token(data: dict, expires_delta: timedelta | None = None):
    to_encode = data.copy()
    expire = datetime.utcnow() + (expires_delta or timedelta(minutes=ACCESS_TOKEN_EXPIRE_MINUTES))
    to_encode.update({"exp": expire})
    return jwt.encode(to_encode, SECRET_KEY, algorithm=ALGORITHM)

async def get_current_user(token: str = Depends(oauth2_scheme)):
    credentials_exception = HTTPException(
        status_code=status.HTTP_401_UNAUTHORIZED,
        detail="Could not validate credentials",
        headers={"WWW-Authenticate": "Bearer"},
    )
    try:
        payload = jwt.decode(token, SECRET_KEY, algorithms=[ALGORITHM])
        user_id: str = payload.get("sub")
        if user_id is None:
            raise credentials_exception
        return user_id
    except JWTError:
        raise credentials_exception

# ====================== LANGUAGE & KNOWLEDGE GRAPH ======================
def detect_language(text: str) -> str:
    if not text or not text.strip():
        return "en"
    try:
        return langdetect.detect(text.strip())
    except:
        return "en"

def translate(text: str, source: str, target: str) -> str:
    try:
        return GoogleTranslator(source=source, target=target).translate(text)
    except Exception as e:
        print(f"Translation failed: {e}")
        return text

def query_knowledge_graph(english_message: str) -> str:
    keywords = [word for word in english_message.lower().split() if len(word) > 3]
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
                node = dict(record["n"])
                rel = record.get("rel_type")
                related = dict(record["m"]) if record["m"] else None
                if rel and related:
                    context_parts.append(f"{node} --[{rel}]--> {related}")
                else:
                    context_parts.append(str(node))

    return "Relevant knowledge graph context:\n" + "\n".join(context_parts) if context_parts else ""
# ====================== AUTO-GENERATE CHAT TITLE ======================
async def generate_chat_title(user_message: str, bot_reply: str) -> str:
    """Generate a short, suitable title using Ollama (only called on first message)"""
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
        data = response.json()

        # Robust parsing
        if "message" in data and "content" in data["message"]:
            title = data["message"]["content"].strip()
        elif "response" in data:
            title = data["response"].strip()
        else:
            title = ""

        # Clean and limit title
        title = title.replace('"', '').replace("'", "").strip()
        if len(title) > 60:
            title = title[:57] + "..."
        if title:
            return title

    except Exception as e:
        print(f"Title generation failed: {e}")

    # Fallback: use first part of user message
    fallback = user_message.strip()[:50]
    return fallback + "..." if len(fallback) == 50 else fallback
# ====================== AUTH ENDPOINTS ======================
@app.post("/register", response_model=Token)
async def register(user: UserCreate):
    existing = await users_collection.find_one({"fisherman_id": user.fisherman_id})
    if existing:
        raise HTTPException(status_code=400, detail="Fisherman ID already registered")

    hashed_password = get_password_hash(user.password)
    user_dict = user.model_dump()
    user_dict["hashed_password"] = hashed_password
    user_dict.pop("password")
    user_dict["created_at"] = datetime.utcnow()

    result = await users_collection.insert_one(user_dict)
    user_id = str(result.inserted_id)

    token = create_access_token({"sub": user_id})
    return {"access_token": token}


@app.post("/login", response_model=Token)
async def login(form_data: OAuth2PasswordRequestForm = Depends()):
    user = await users_collection.find_one({"fisherman_id": form_data.username})
    if not user or not verify_password(form_data.password, user.get("hashed_password", "")):
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Incorrect fisherman ID or password",
            headers={"WWW-Authenticate": "Bearer"},
        )

    token = create_access_token({"sub": str(user["_id"])})
    return {"access_token": token}

# ====================== GET CURRENT USER INFO ======================
@app.get("/user")
async def get_current_user_info(token: str = Depends(oauth2_scheme)):
    user_id = await get_current_user(token)
    
    user = await users_collection.find_one({"_id": ObjectId(user_id)})
    if not user:
        raise HTTPException(status_code=404, detail="User not found")

    return {
        "name": user.get("name", "Fisherman"),
        "fisherman_id": user.get("fisherman_id")
    }
# ====================== CHAT HISTORY ======================
@app.get("/chats")
async def get_user_chats(token: str = Depends(oauth2_scheme)):
    user_id = await get_current_user(token)
    chats = await chats_collection.find(
        {"user_id": user_id}
    ).sort([("pinned", -1), ("updated_at", -1)]).to_list(length=50)   # pinned first
    
    for chat in chats:
        chat["_id"] = str(chat["_id"])
    return chats

@app.post("/chats")
async def create_new_chat(token: str = Depends(oauth2_scheme)):
    user_id = await get_current_user(token)
    chat_doc = {
        "user_id": user_id,
        "title": "New Chat",
        "messages": [],
        "pinned": False,          # ← NEW
        "created_at": datetime.utcnow(),
        "updated_at": datetime.utcnow()
    }
    result = await chats_collection.insert_one(chat_doc)
    return {"chat_id": str(result.inserted_id), "title": "New Chat"}

# ====================== DELETE CHAT ENDPOINT ======================
@app.delete("/chats/{chat_id}")
async def delete_chat(
    chat_id: str = Path(..., description="Chat ID to delete"),
    token: str = Depends(oauth2_scheme)
):
    user_id = await get_current_user(token)          # this is a string
    
    try:
        chat_id_obj = ObjectId(chat_id)
    except Exception:
        raise HTTPException(status_code=400, detail="Invalid chat_id format")

    # First find the chat (without user filter) to give better error messages
    chat = await chats_collection.find_one({"_id": chat_id_obj})
    if not chat:
        raise HTTPException(status_code=404, detail="Chat not found")

    # Check ownership - handles both string and ObjectId stored in DB
    stored_user_id = chat.get("user_id")
    if str(stored_user_id) != str(user_id):
        raise HTTPException(
            status_code=403, 
            detail="You do not have permission to delete this chat"
        )

    # Now safely delete
    result = await chats_collection.delete_one({"_id": chat_id_obj})
    
    if result.deleted_count == 0:
        raise HTTPException(status_code=404, detail="Failed to delete chat")

    return {"status": "deleted", "message": "Chat successfully deleted"}
# ====================== GET SINGLE CHAT (for sharing) ======================
@app.get("/chats/{chat_id}")
async def get_chat_by_id(chat_id: str, token: str = Depends(oauth2_scheme)):
    user_id = await get_current_user(token)
    try:
        chat_id_obj = ObjectId(chat_id)
    except Exception:
        raise HTTPException(status_code=400, detail="Invalid chat_id format")

    chat = await chats_collection.find_one({"_id": chat_id_obj, "user_id": user_id})
    if not chat:
        raise HTTPException(status_code=404, detail="Chat not found or you do not have permission")

    chat["_id"] = str(chat["_id"])
    return chat
# ====================== RENAME CHAT TITLE ======================
@app.put("/chats/{chat_id}/title")
async def update_chat_title(chat_id: str, body: TitleUpdate, token: str = Depends(oauth2_scheme)):
    user_id = await get_current_user(token)
    try:
        chat_id_obj = ObjectId(chat_id)
    except Exception:
        raise HTTPException(status_code=400, detail="Invalid chat_id format")

    result = await chats_collection.update_one(
        {"_id": chat_id_obj, "user_id": user_id},
        {"$set": {"title": body.title.strip() or "Untitled Chat"}}
    )

    if result.modified_count == 0:
        raise HTTPException(status_code=404, detail="Chat not found or you do not have permission to rename it")

    return {"status": "success", "title": body.title}
# ====================== TOGGLE PIN CHAT ======================
@app.put("/chats/{chat_id}/pin")
async def toggle_pin_chat(chat_id: str, body: PinUpdate, token: str = Depends(oauth2_scheme)):
    user_id = await get_current_user(token)
    try:
        chat_id_obj = ObjectId(chat_id)
    except Exception:
        raise HTTPException(status_code=400, detail="Invalid chat_id format")

    result = await chats_collection.update_one(
        {"_id": chat_id_obj, "user_id": user_id},
        {"$set": {"pinned": body.pinned}}
    )

    if result.modified_count == 0:
        raise HTTPException(status_code=404, detail="Chat not found or you do not have permission")

    return {"status": "success", "pinned": body.pinned}
# ====================== CHAT MESSAGE SAVING ======================
async def save_chat_message(user_id: str, chat_id: str, user_message: str, bot_reply: str):
    try:
        chat_id_obj = ObjectId(chat_id)
    except Exception:
        raise HTTPException(status_code=400, detail="Invalid chat_id format")

    chat_obj = await chats_collection.find_one({"_id": chat_id_obj, "user_id": user_id})
    if not chat_obj:
        raise HTTPException(status_code=404, detail="Chat not found")

    new_messages = [
        {"sender": "user", "content": user_message, "timestamp": datetime.utcnow()},
        {"sender": "bot", "content": bot_reply, "timestamp": datetime.utcnow()}
    ]

    await chats_collection.update_one(
        {"_id": chat_id_obj},
        {
            "$push": {"messages": {"$each": new_messages}},
            "$set": {"updated_at": datetime.utcnow()}
        }
    )

# ====================== MAIN CHAT ENDPOINT ======================
@app.post("/chat")
async def chat_endpoint(request: ChatRequest, token: str = Depends(oauth2_scheme)):
    user_id = await get_current_user(token)

    user_message = request.message.strip()
    chat_id = request.chat_id

    detected_lang = detect_language(user_message)
    is_bangla = detected_lang == "bn"
    english_message = translate(user_message, "bn", "en") if is_bangla else user_message

    kg_context = await asyncio.to_thread(query_knowledge_graph, english_message)

    if not kg_context:
        no_info_reply = "দুঃখিত, এই বিষয়ে আমার কাছে কোনো তথ্য নেই।" if is_bangla else "Sorry, I don't have information on that topic."
        await save_chat_message(user_id, chat_id, user_message, no_info_reply)
        return {"reply": no_info_reply}

    language_instruction = "You MUST reply in Bangla script only." if is_bangla else "Reply in English."

    try:
        response = requests.post(OLLAMA_URL, json={
            "model": MODEL_NAME,
            "messages": [
                {"role": "system", "content": f"You are a helpful assistant for Bangladeshi fishermen. Use only the provided context. {language_instruction}"},
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

        # Save the message first
        await save_chat_message(user_id, chat_id, user_message, reply)

        # Auto-generate suitable title ONLY if this is the first message pair
        chat_obj = await chats_collection.find_one({"_id": ObjectId(chat_id)})
        if chat_obj and len(chat_obj.get("messages", [])) == 2:   # exactly one user + one bot message
            new_title = await generate_chat_title(user_message, reply)
            await chats_collection.update_one(
                {"_id": ObjectId(chat_id)},
                {"$set": {"title": new_title}}
            )

        return {"reply": reply}

    except Exception as e:
        print(f"Chat error: {e}")
        error_reply = "দুঃখিত, সার্ভারে সমস্যা হয়েছে।" if is_bangla else "Sorry, something went wrong."
        await save_chat_message(user_id, chat_id, user_message, error_reply)
        return {"reply": error_reply}

# ====================== FEEDBACK ======================
# ====================== SAVE FEEDBACK (Positive + Negative) ======================
@app.post("/feedback")
async def save_feedback(feedback: FeedbackRequest, token: str = Depends(oauth2_scheme)):
    user_id = await get_current_user(token)
    
    feedback_dict = feedback.model_dump()
    feedback_dict["user_id"] = user_id
    feedback_dict["timestamp"] = datetime.utcnow()

    # Ensure type is valid
    if feedback_dict["type"] not in ["positive", "negative"]:
        feedback_dict["type"] = "negative"   # fallback

    await feedbacks_collection.insert_one(feedback_dict)
    
    return {"status": "ok", "type": feedback_dict["type"]}

@app.on_event("shutdown")
async def shutdown():
    if neo4j_driver:
        neo4j_driver.close()
