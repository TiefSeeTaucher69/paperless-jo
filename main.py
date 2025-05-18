import os
import json
import logging
import hashlib
import numpy as np
from datetime import datetime
from typing import List, Dict, Optional, Any, Union, Tuple
import time

import requests
import uvicorn
from fastapi import FastAPI, HTTPException, Depends, BackgroundTasks
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel, Field
from dotenv import load_dotenv
from tqdm import tqdm
import torch
from sentence_transformers import SentenceTransformer, CrossEncoder
import chromadb
from chromadb.utils import embedding_functions
from rank_bm25 import BM25Okapi
import nltk
from nltk.tokenize import word_tokenize
from nltk.corpus import stopwords

# Configure logging
logging.basicConfig(
    level=logging.INFO,
    format='%(asctime)s - %(name)s - %(levelname)s - %(message)s',
    handlers=[logging.StreamHandler()]
)
logger = logging.getLogger("RAGZ")

# Load environment variables from data directory
data_env_path = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'data', '.env')
if os.path.exists(data_env_path):
    load_dotenv(dotenv_path=data_env_path, verbose=True)
    logger.info(f"Loaded environment variables from {data_env_path}")
else:
    # Fallback to local .env file if none exists in data folder
    local_env_path = os.path.join(os.path.dirname(os.path.abspath(__file__)), '.env')
    if os.path.exists(local_env_path):
        load_dotenv(dotenv_path=local_env_path, verbose=True)
        logger.info(f"Loaded environment variables from {local_env_path}")
    else:
        logger.warning("No .env file found in data directory or locally")

# Debug: Print loaded environment variables for troubleshooting
logger.info(f"Loaded PAPERLESS_URL: {os.getenv('PAPERLESS_URL')}")
logger.info(f"Loaded PAPERLESS_NGX_URL: {os.getenv('PAPERLESS_NGX_URL')}")
logger.info(f"Loaded PAPERLESS_HOST: {os.getenv('PAPERLESS_HOST')}")
logger.info(f"Loaded PAPERLESS_API_TOKEN: {'[SET]' if os.getenv('PAPERLESS_API_TOKEN') else '[NOT SET]'}")

# Constants
DOCUMENTS_FILE = "./data/documents.json"
CHROMADB_DIR = "./data/chromadb"
EMBEDDING_MODEL_NAME = "paraphrase-multilingual-MiniLM-L12-v2"
CROSS_ENCODER_MODEL_NAME = "cross-encoder/ms-marco-MiniLM-L-6-v2"
COLLECTION_NAME = "documents"
BM25_WEIGHT = 0.3
SEMANTIC_WEIGHT = 0.7
MAX_RESULTS = 20

# Download NLTK resources if not present
nltk.download('punkt', quiet=True)
nltk.download('punkt_tab', quiet=True)
nltk.download('stopwords', quiet=True)

# Status und Konfiguration
class IndexingStatus(BaseModel):
    running: bool = False
    last_indexed: Optional[str] = None
    documents_count: int = 0
    up_to_date: bool = False
    message: str = ""

class SystemStatus(BaseModel):
    server_up: bool = True
    data_loaded: bool = False
    index_ready: bool = False
    chroma_ready: bool = False
    bm25_ready: bool = False
    indexing_status: IndexingStatus = IndexingStatus()

# Request models
class SearchRequest(BaseModel):
    query: str
    from_date: Optional[str] = None
    to_date: Optional[str] = None
    correspondent: Optional[str] = None

class IndexingRequest(BaseModel):
    force: bool = False
    background: bool = True

class AskQuestionRequest(BaseModel):
    question: str
    max_sources: int = 5

# Response models
class SearchResult(BaseModel):
    title: str
    correspondent: str
    date: str
    score: float
    cross_score: float
    snippet: str
    doc_id: Optional[int] = None

# Global state object
class GlobalState:
    def __init__(self):
        self.data_manager = None
        self.search_engine = None
        self.system_status = SystemStatus()
        self.indexing_status = IndexingStatus()

global_state = GlobalState()

# Data Manager
class DataManager:
    def __init__(self, initialize_on_start=False):
        # Flexible Variablennamen für die API-Einstellungen - erweitert um PAPERLESS_API_URL
        paperless_api_url = os.getenv("PAPERLESS_API_URL") or os.getenv("PAPERLESS_URL") or os.getenv("PAPERLESS_NGX_URL") or os.getenv("PAPERLESS_HOST")
        
        # Entfernen des /api Suffix falls vorhanden
        if paperless_api_url and paperless_api_url.endswith('/api'):
            paperless_api_url = paperless_api_url[:-4]  # Entfernen der letzten 4 Zeichen (/api)
            logger.info(f"Removed '/api' suffix from URL: {paperless_api_url}")
        
        self.paperless_url = paperless_api_url
        self.paperless_token = os.getenv("PAPERLESS_TOKEN") or os.getenv("PAPERLESS_API_TOKEN") or os.getenv("PAPERLESS_APIKEY")
        
        # Debug-Informationen ausgeben
        logger.info(f"Environment variables: PAPERLESS_API_URL={os.getenv('PAPERLESS_API_URL')}, PAPERLESS_URL={os.getenv('PAPERLESS_URL')}, PAPERLESS_NGX_URL={os.getenv('PAPERLESS_NGX_URL')}, PAPERLESS_HOST={os.getenv('PAPERLESS_HOST')}")
        logger.info(f"Environment variables: PAPERLESS_TOKEN={'[SET]' if os.getenv('PAPERLESS_TOKEN') else '[NOT SET]'}, PAPERLESS_API_TOKEN={'[SET]' if os.getenv('PAPERLESS_API_TOKEN') else '[NOT SET]'}, PAPERLESS_APIKEY={'[SET]' if os.getenv('PAPERLESS_APIKEY') else '[NOT SET]'}")
        
        if not self.paperless_url or not self.paperless_token:
            logger.error("Missing PAPERLESS_API_URL/PAPERLESS_URL or PAPERLESS_API_TOKEN in .env file")
            raise ValueError("Missing Paperless API configuration in .env file")
        
        self.documents = []
        self.document_hashes = {}
        self.last_sync = None
        self.collection = None
        self.is_initialized = False
        self.chroma_initialized = False
        
        # Modelle nur initialisieren, wenn sie benötigt werden
        self.sentence_transformer = None
        self.embedding_function = None
        self.cross_encoder = None
        self.chroma_client = None
        
        # Wenn True, initialisiere beim Start
        if initialize_on_start:
            self.initialize_models()
            self.load_documents()
    
    def initialize_models(self):
        """Initialisiere NLP-Modelle und ChromaDB"""
        if self.sentence_transformer is None:
            logger.info("Initializing sentence transformer model")
            self.sentence_transformer = SentenceTransformer(EMBEDDING_MODEL_NAME)
            
        if self.embedding_function is None:
            logger.info("Initializing embedding function")
            self.embedding_function = embedding_functions.SentenceTransformerEmbeddingFunction(
                model_name=EMBEDDING_MODEL_NAME
            )
            
        if self.cross_encoder is None:
            logger.info("Initializing cross-encoder model")
            self.cross_encoder = CrossEncoder(CROSS_ENCODER_MODEL_NAME)
            
        if self.chroma_client is None:
            logger.info("Initializing ChromaDB client")
            self.chroma_client = chromadb.PersistentClient(path=CHROMADB_DIR)
            
        self.is_initialized = True
    
    def _get_headers(self):
        return {"Authorization": f"Token {self.paperless_token}"}
    
    def _compute_document_hash(self, doc):
        """Compute a hash for a document to track changes"""
        content = f"{doc['title']}{doc['content']}{doc['correspondent']}"
        return hashlib.sha256(content.encode()).hexdigest()
    
    def check_for_updates(self) -> Tuple[bool, str]:
        """Überprüft, ob neue Dokumente vorhanden sind, ohne sie herunterzuladen"""
        logger.info("Checking for document updates")
        
        try:
            # Prüfe nur die ersten Seite der API, um zu sehen, ob es Änderungen gibt
            url = f"{self.paperless_url}/api/documents/?page=1&page_size=10"
            response = requests.get(
                url,
                headers=self._get_headers(),
                timeout=10
            )
            
            if response.status_code != 200:
                return False, f"API error: {response.status_code}"
                
            # Nur die letzte Änderungszeit des neuesten Dokuments prüfen
            data = response.json()
            results = data.get("results", [])
            
            if not results:
                return False, "No documents found in API"
                
            newest_doc = results[0]  # API sortiert nach neuestem Dokument
            newest_modified = newest_doc.get("modified", "")
            
            # Lokale Dokumente prüfen
            if os.path.exists(DOCUMENTS_FILE):
                with open(DOCUMENTS_FILE, 'r', encoding='utf-8') as f:
                    local_documents = json.load(f)
                
                if not local_documents:
                    return True, "Local document file is empty, update needed"
                    
                local_newest = max(local_documents, key=lambda x: x.get("last_updated", ""))
                local_newest_date = local_newest.get("last_updated", "")
                
                if newest_modified > local_newest_date:
                    return True, "Remote documents are newer than local documents"
                else:
                    return False, "Local documents are up to date"
            else:
                return True, "No local documents file exists"
                
        except Exception as e:
            logger.error(f"Error checking for updates: {str(e)}")
            return False, f"Error: {str(e)}"
    
    def fetch_documents_from_api(self):
        """Fetch all documents from Paperless-NGX API with pagination"""
        logger.info(f"Fetching documents from Paperless-NGX API: {self.paperless_url}")
        
        documents = []
        page = 1
        has_next = True
        
        while has_next:
            logger.info(f"Fetching page {page}")
            try:
                url = f"{self.paperless_url}/api/documents/?page={page}&page_size=100"
                logger.info(f"Making request to: {url}")
                
                response = requests.get(
                    url,
                    headers=self._get_headers(),
                    timeout=30
                )
                
                # Log response information for debugging
                logger.info(f"Response status code: {response.status_code}")
                
                if response.status_code != 200:
                    logger.error(f"Failed to fetch documents: {response.status_code} - {response.text}")
                    raise Exception(f"API error: {response.status_code} - {response.text}")
                
                # Check if response is empty
                if not response.text:
                    logger.error("API returned empty response")
                    raise Exception("API returned empty response")
                
                try:
                    data = response.json()
                except requests.exceptions.JSONDecodeError as e:
                    logger.error(f"JSON decode error: {str(e)}")
                    logger.error(f"Response content: {response.text}")
                    raise Exception(f"Could not parse API response as JSON: {str(e)}")
                
                results = data.get("results", [])
                documents.extend(results)
                
                # Check if there's a next page
                if data.get("next"):
                    page += 1
                else:
                    has_next = False
                    
            except requests.exceptions.RequestException as e:
                logger.error(f"Request error: {str(e)}")
                raise Exception(f"API request failed: {str(e)}")
        
        # Process documents to extract required fields
        processed_docs = []
        for doc in tqdm(documents, desc="Processing documents"):
            # Fetch document content if not included in listing
            if "content" not in doc or not doc["content"]:
                content_response = requests.get(
                    f"{self.paperless_url}/api/documents/{doc['id']}/download/txt/",
                    headers=self._get_headers(),
                    timeout=30
                )
                
                if content_response.status_code == 200:
                    content = content_response.text
                else:
                    logger.warning(f"Could not fetch content for document {doc['id']}")
                    content = ""
            else:
                content = doc.get("content", "")
            
            # Get correspondent name
            correspondent = ""
            if doc.get("correspondent"):
                corr_id = doc["correspondent"]
                corr_response = requests.get(
                    f"{self.paperless_url}/api/correspondents/{corr_id}/",
                    headers=self._get_headers(),
                    timeout=10
                )
                
                if corr_response.status_code == 200:
                    correspondent = corr_response.json().get("name", "")
            
            # Get tag names
            tags = []
            if doc.get("tags"):
                for tag_id in doc["tags"]:
                    tag_response = requests.get(
                        f"{self.paperless_url}/api/tags/{tag_id}/",
                        headers=self._get_headers(),
                        timeout=10
                    )
                    
                    if tag_response.status_code == 200:
                        tags.append(tag_response.json().get("name", ""))
            
            # Create processed document
            processed_doc = {
                "id": doc.get("id"),
                "title": doc.get("title", ""),
                "content": content,
                "correspondent": correspondent,
                "created": doc.get("created_date", doc.get("created", "")),
                "tags": tags,
                "last_updated": doc.get("modified", "")
            }
            
            # Compute document hash
            processed_doc["hash"] = self._compute_document_hash(processed_doc)
            processed_docs.append(processed_doc)
        
        return processed_docs
    
    def load_documents(self, force_refresh=False):
        """Load documents from file or API with option to force refresh"""
        if os.path.exists(DOCUMENTS_FILE) and not force_refresh:
            logger.info(f"Loading documents from {DOCUMENTS_FILE}")
            try:
                with open(DOCUMENTS_FILE, 'r', encoding='utf-8') as f:
                    local_documents = json.load(f)
                
                # Load document hashes
                self.document_hashes = {doc["id"]: doc["hash"] for doc in local_documents if "hash" in doc}
                self.last_sync = datetime.now().isoformat()
                self.documents = local_documents
                
                global_state.system_status.data_loaded = True
                global_state.indexing_status.documents_count = len(local_documents)
                global_state.indexing_status.last_indexed = self.last_sync
                
                return local_documents
            except Exception as e:
                logger.error(f"Error loading documents: {str(e)}")
                return []
        else:
            if force_refresh:
                logger.info("Forcing refresh from API")
            else:
                logger.info("No local documents found, fetching from API")
                
            try:
                self.documents = self.fetch_documents_from_api()
                self.save_documents()
                
                global_state.system_status.data_loaded = True
                global_state.indexing_status.documents_count = len(self.documents)
                global_state.indexing_status.last_indexed = datetime.now().isoformat()
                
                return self.documents
            except Exception as e:
                logger.error(f"Error fetching documents: {str(e)}")
                return []
    
    def save_documents(self):
        """Save documents to file"""
        # Ensure directory exists
        os.makedirs(os.path.dirname(DOCUMENTS_FILE), exist_ok=True)
        
        with open(DOCUMENTS_FILE, 'w', encoding='utf-8') as f:
            json.dump(self.documents, f, ensure_ascii=False, indent=2)
        logger.info(f"Saved {len(self.documents)} documents to {DOCUMENTS_FILE}")
    
    def setup_chroma_collection(self, force_update=False):
        """Set up ChromaDB collection with option to force update"""
        if not self.is_initialized:
            self.initialize_models()
        
        # Ensure ChromaDB directory exists
        os.makedirs(CHROMADB_DIR, exist_ok=True)
            
        # Check if collection exists
        try:
            existing_collections = self.chroma_client.list_collections()
            collection_exists = any(c.name == COLLECTION_NAME for c in existing_collections)
            
            if collection_exists and not force_update:
                collection = self.chroma_client.get_collection(
                    name=COLLECTION_NAME,
                    embedding_function=self.embedding_function
                )
                logger.info(f"Loaded existing ChromaDB collection '{COLLECTION_NAME}'")
                
                self.collection = collection
                self.chroma_initialized = True
                global_state.system_status.chroma_ready = True
                
                return collection
            else:
                if force_update and collection_exists:
                    logger.info(f"Forcing update of ChromaDB collection '{COLLECTION_NAME}'")
                    self.chroma_client.delete_collection(COLLECTION_NAME)
                
                logger.info(f"Creating new ChromaDB collection '{COLLECTION_NAME}'")
                collection = self.chroma_client.create_collection(
                    name=COLLECTION_NAME,
                    embedding_function=self.embedding_function
                )
                
                # Load documents if not already loaded
                if not self.documents:
                    self.load_documents()
                
                # Add all documents to collection
                self._add_documents_to_chroma(collection, self.documents)
                
                self.collection = collection
                self.chroma_initialized = True
                global_state.system_status.chroma_ready = True
                
                return collection
                
        except Exception as e:
            logger.error(f"Error setting up ChromaDB collection: {str(e)}")
            global_state.system_status.chroma_ready = False
            self.chroma_initialized = False
            raise
    
    def _add_documents_to_chroma(self, collection, documents):
        """Add documents to ChromaDB collection"""
        # We process in batches to avoid memory issues
        batch_size = 100
        total_docs = len(documents)
        
        for i in range(0, total_docs, batch_size):
            batch = documents[i:i+batch_size]
            logger.info(f"Processing batch {i//batch_size + 1}/{(total_docs-1)//batch_size + 1} ({len(batch)} documents)")
            
            ids = [str(doc["id"]) for doc in batch]
            
            # Prepare texts for embedding
            texts = [
                f"{doc['title']} {doc['correspondent']} {doc['content']}"
                for doc in batch
            ]
            
            # Prepare metadata
            metadatas = [
                {
                    "title": doc["title"],
                    "correspondent": doc["correspondent"],
                    "created": doc["created"],
                    "tags": ", ".join(doc["tags"]),
                    "hash": doc["hash"]
                }
                for doc in batch
            ]
            
            # Add or update documents in collection
            collection.upsert(
                ids=ids,
                documents=texts,
                metadatas=metadatas
            )
        
        logger.info(f"Added/updated {total_docs} documents to ChromaDB collection")


# Search Engine
class SearchEngine:
    def __init__(self, data_manager, initialize_on_start=False):
        self.data_manager = data_manager
        self.collection = None
        self.documents = None
        self.bm25 = None
        self.tokenized_corpus = None
        self.is_initialized = False
        self.bm25_initialized = False
        
        # Wenn True, initialisiere beim Start
        if initialize_on_start and self.data_manager.is_initialized:
            self.initialize()
    
    def initialize(self, force_update=False):
        """Initialize search engine with option to force update"""
        # Load documents if not already loaded
        if not self.data_manager.documents:
            self.documents = self.data_manager.load_documents()
        else:
            self.documents = self.data_manager.documents
        
        # Set up ChromaDB collection if not already set up
        if not self.data_manager.chroma_initialized or force_update:
            self.collection = self.data_manager.setup_chroma_collection(force_update=force_update)
        else:
            self.collection = self.data_manager.collection
        
        # Set up BM25
        self._setup_bm25()
        
        self.is_initialized = True
        global_state.system_status.index_ready = True
        logger.info("Search engine initialized")
    
    def _setup_bm25(self):
        """Set up BM25 index"""
        logger.info("Initializing BM25 index")
        
        # Prepare corpus for BM25
        self.tokenized_corpus = []
        
        # Get stopwords for multiple languages
        stop_words = set()
        for lang in ['english', 'german', 'french', 'spanish', 'italian']:
            try:
                stop_words.update(stopwords.words(lang))
            except:
                pass
        
        # Tokenize documents
        for doc in tqdm(self.documents, desc="Tokenizing documents for BM25"):
            # Combine title, correspondent and content for search
            text = f"{doc['title']} {doc['correspondent']} {doc['content']}"
            
            # Tokenize and filter stopwords
            tokens = word_tokenize(text.lower())
            filtered_tokens = [token for token in tokens if token not in stop_words]
            
            self.tokenized_corpus.append(filtered_tokens)
        
        # Create BM25 index
        self.bm25 = BM25Okapi(self.tokenized_corpus)
        self.bm25_initialized = True
        global_state.system_status.bm25_ready = True
        logger.info("BM25 index initialized")
    
    def keyword_search(self, query, top_k=MAX_RESULTS):
        """Perform keyword search using BM25"""
        if not self.is_initialized:
            raise Exception("Search engine not initialized")
            
        # Tokenize query
        query_tokens = word_tokenize(query.lower())
        
        # Get BM25 scores
        scores = self.bm25.get_scores(query_tokens)
        
        # Get document indices sorted by score
        doc_scores = [(i, score) for i, score in enumerate(scores)]
        doc_scores.sort(key=lambda x: x[1], reverse=True)
        
        # Get top-k documents
        results = []
        for i, score in doc_scores[:top_k]:
            if score > 0:  # Only include documents with non-zero scores
                doc = self.documents[i]
                results.append({
                    "id": doc["id"],
                    "title": doc["title"],
                    "correspondent": doc["correspondent"],
                    "date": doc["created"],
                    "score": float(score),
                    "content": doc["content"]
                })
        
        return results
    
    def semantic_search(self, query, top_k=MAX_RESULTS):
        """Perform semantic search using ChromaDB"""
        if not self.is_initialized:
            raise Exception("Search engine not initialized")
            
        results = self.collection.query(
            query_texts=[query],
            n_results=top_k
        )
        
        documents = []
        for i, doc_id in enumerate(results["ids"][0]):
            # Find the document in our list
            doc = next((d for d in self.documents if str(d["id"]) == doc_id), None)
            
            if doc:
                documents.append({
                    "id": doc["id"],
                    "title": doc["title"],
                    "correspondent": doc["correspondent"],
                    "date": doc["created"],
                    "score": float(results["distances"][0][i]) if "distances" in results else 1.0,
                    "content": doc["content"]
                })
        
        return documents
    
    def hybrid_search(self, query, top_k=MAX_RESULTS):
        """Perform hybrid search combining BM25 and semantic search"""
        if not self.is_initialized:
            raise Exception("Search engine not initialized")
            
        # Get results from both search methods
        keyword_results = self.keyword_search(query, top_k=top_k*2)
        semantic_results = self.semantic_search(query, top_k=top_k*2)
        
        # Combine results
        results_map = {}
        
        # Normalize scores
        if keyword_results:
            max_keyword_score = max(r["score"] for r in keyword_results)
            for r in keyword_results:
                r["score"] = r["score"] / max_keyword_score if max_keyword_score > 0 else 0
        
        if semantic_results:
            # For semantic search, lower distance is better, so invert the score
            for r in semantic_results:
                # Convert distance to similarity score (1 - normalized_distance)
                r["score"] = 1 - r["score"] if r["score"] <= 1 else 0
        
        # Add keyword results with weight
        for result in keyword_results:
            doc_id = result["id"]
            results_map[doc_id] = {
                **result,
                "score": result["score"] * BM25_WEIGHT
            }
        
        # Add semantic results with weight
        for result in semantic_results:
            doc_id = result["id"]
            if doc_id in results_map:
                results_map[doc_id]["score"] += result["score"] * SEMANTIC_WEIGHT
            else:
                results_map[doc_id] = {
                    **result,
                    "score": result["score"] * SEMANTIC_WEIGHT
                }
        
        # Convert map to list and sort by score
        combined_results = list(results_map.values())
        combined_results.sort(key=lambda x: x["score"], reverse=True)
        
        return combined_results[:top_k]
    
    def rerank_results(self, query, results, top_k=MAX_RESULTS):
        """Rerank results using cross-encoder"""
        if not results:
            return []
        
        # Prepare pairs for cross-encoder
        pairs = [(query, result["title"] + " " + result["content"][:500]) for result in results]
        
        # Get cross-encoder scores
        cross_scores = self.data_manager.cross_encoder.predict(pairs)
        
        # Add cross-encoder scores to results
        for i, score in enumerate(cross_scores):
            # Convert score to a positive value by taking the sigmoid 
            # This maps any score to a value between 0 and 1
            # For cross-encoders, higher should be better matches
            norm_score = 1.0 / (1.0 + np.exp(-score))
            results[i]["cross_score"] = float(norm_score)
        
        # Sort by cross-encoder score
        results.sort(key=lambda x: x["cross_score"], reverse=True)
        
        return results[:top_k]
    
    def create_snippet(self, query, content, max_len=200):
        """Create a relevant snippet from the document content"""
        if not content:
            return ""
        
        # Get query terms
        query_terms = set(word_tokenize(query.lower()))
        
        # Split content into sentences
        sentences = content.split(". ")
        
        # Score sentences by number of query terms
        sentence_scores = []
        for sentence in sentences:
            sentence_terms = set(word_tokenize(sentence.lower()))
            score = len(query_terms.intersection(sentence_terms))
            sentence_scores.append((sentence, score))
        
        # Sort sentences by score
        sentence_scores.sort(key=lambda x: x[1], reverse=True)
        
        # Create snippet from top sentences
        snippet = ""
        for sentence, _ in sentence_scores:
            if len(snippet) + len(sentence) <= max_len:
                snippet += sentence + ". "
            else:
                break
        
        # If snippet is empty (no term matches), just use the beginning of the content
        if not snippet:
            snippet = content[:max_len] + "..."
        
        return snippet.strip()
    
    def search(self, request: SearchRequest):
        """Perform full search with filters and reranking"""
        if not self.is_initialized:
            raise Exception("Search engine not initialized")
            
        query = request.query
        
        # Perform hybrid search
        results = self.hybrid_search(query)
        
        # Apply filters
        if request.from_date or request.to_date or request.correspondent:
            filtered_results = []
            for result in results:
                include = True
                
                # Filter by date range
                if request.from_date and result["date"]:
                    try:
                        doc_date = result["date"].split("T")[0]  # Get date part only
                        if doc_date < request.from_date:
                            include = False
                    except:
                        pass
                
                if request.to_date and result["date"]:
                    try:
                        doc_date = result["date"].split("T")[0]  # Get date part only
                        if doc_date > request.to_date:
                            include = False
                    except:
                        pass
                
                # Filter by correspondent
                if request.correspondent and result["correspondent"]:
                    if request.correspondent.lower() not in result["correspondent"].lower():
                        include = False
                
                if include:
                    filtered_results.append(result)
            
            results = filtered_results
        
        # Rerank results
        reranked_results = self.rerank_results(query, results)
        
        # Format results
        formatted_results = []
        for result in reranked_results:
            snippet = self.create_snippet(query, result["content"])
            
            formatted_results.append(SearchResult(
                title=result["title"],
                correspondent=result["correspondent"],
                date=result["date"],
                score=result["score"],
                cross_score=result["cross_score"],
                snippet=snippet,
                doc_id=result["id"]
            ))
        
        return formatted_results

# Indexierung als Hintergrundaufgabe
def run_indexing(force_update=False):
    """Führt die Indexierung als Hintergrundaufgabe aus"""
    try:
        global_state.indexing_status.running = True
        global_state.indexing_status.message = "Indexierung gestartet"
        
        # Dokumente aktualisieren, wenn nötig
        if force_update:
            global_state.indexing_status.message = "Dokumente werden neu geladen"
            global_state.data_manager.load_documents(force_refresh=True)
        
        # Suchmaschine initialisieren oder aktualisieren
        global_state.indexing_status.message = "Suchindex wird erstellt"
        global_state.search_engine.initialize(force_update=force_update)
        
        # Status aktualisieren
        global_state.indexing_status.running = False
        global_state.indexing_status.last_indexed = datetime.now().isoformat()
        global_state.indexing_status.up_to_date = True
        global_state.indexing_status.message = "Indexierung abgeschlossen"
        
    except Exception as e:
        global_state.indexing_status.running = False
        global_state.indexing_status.message = f"Fehler bei der Indexierung: {str(e)}"
        logger.error(f"Indexing error: {str(e)}")

# FastAPI Application
app = FastAPI(title="RAGZ Document Search API")

# Add CORS middleware
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],  # In production, restrict to your Node.js server
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# Abhängigkeit zur Überprüfung, ob die Suchmaschine initialisiert ist
def get_search_engine():
    if not global_state.search_engine or not global_state.search_engine.is_initialized:
        raise HTTPException(
            status_code=503, 
            detail="Search engine not initialized. Please initialize the engine first."
        )
    return global_state.search_engine

@app.on_event("startup")
async def startup_event():
    """Minimal startup - initialize only the global state and managers"""
    global global_state
    
    logger.info("Starting RAGZ Document Search API")
    
    try:
        # Überprüfen, ob .env-Datei existiert
        env_file_path = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'data', '.env')
        if not os.path.exists(env_file_path):
            logger.warning(f".env file not found at {os.path.abspath(env_file_path)}")
            logger.info("Creating example .env file")
            
            # Ensure directory exists
            os.makedirs(os.path.dirname(env_file_path), exist_ok=True)
            
            with open(env_file_path, "w") as f:
                f.write("# Paperless-NGX API configuration\n")
                f.write("PAPERLESS_URL=https://your-paperless-instance\n")
                f.write("PAPERLESS_API_TOKEN=your-api-token\n")
            logger.info(f"Created example .env file at {os.path.abspath(env_file_path)}")
            logger.info("Please edit the .env file with your Paperless-NGX API configuration")
            logger.warning("Starting with limited functionality due to missing API configuration")
            
            # Trotzdem fortfahren mit eingeschränkter Funktionalität
            global_state.system_status.server_up = True
            global_state.indexing_status.message = "API configuration missing in .env file"
            return
            
        # Initialisiere DataManager ohne Dokumentenladung
        global_state.data_manager = DataManager(initialize_on_start=False)
        
        # Initialisiere SearchEngine ohne Indexierung
        global_state.search_engine = SearchEngine(global_state.data_manager, initialize_on_start=False)
        
        # Minimaler Start ist abgeschlossen
        logger.info("RAGZ Document Search API minimal startup completed")
        
        # Prüfe, ob Dokumente vorhanden sind und lade sie, falls ja
        if os.path.exists(DOCUMENTS_FILE):
            logger.info("Found existing documents file, loading...")
            global_state.data_manager.load_documents()
            global_state.system_status.data_loaded = True
            
    except Exception as e:
        logger.error(f"Error during startup: {str(e)}")
        global_state.system_status.server_up = True  # Server läuft, aber mit Einschränkungen
        global_state.indexing_status.message = f"Error during startup: {str(e)}"

@app.post("/search", response_model=List[SearchResult])
async def search_documents(request: SearchRequest, search_engine: SearchEngine = Depends(get_search_engine)):
    """Search documents with the given query and filters"""
    try:
        logger.info(f"Search request: {request}")
        return search_engine.search(request)
    except Exception as e:
        logger.error(f"Search error: {str(e)}")
        raise HTTPException(status_code=500, detail=str(e))

@app.post("/context", response_model=dict)
async def get_context(request: AskQuestionRequest, search_engine: SearchEngine = Depends(get_search_engine)):
    """Get context for a question without answering it"""
    try:
        logger.info(f"Context request: {request.question}")
        
        # Search for relevant documents
        search_results = search_engine.search(SearchRequest(query=request.question))
        
        # Prepare sources
        sources = []
        context = ""
        
        for i, result in enumerate(search_results[:request.max_sources]):
            context += f"Document {i+1}: {result.title}\n{result.snippet}\n\n"
            sources.append({
                "title": result.title,
                "correspondent": result.correspondent,
                "date": result.date,
                "snippet": result.snippet,
                "doc_id": result.doc_id
            })
        
        return {
            "context": context,
            "sources": sources,
            "query": request.question
        }
    except Exception as e:
        logger.error(f"Context error: {str(e)}")
        raise HTTPException(status_code=500, detail=str(e))

@app.get("/status", response_model=SystemStatus)
async def get_status():
    """Get system status"""
    return global_state.system_status

@app.get("/indexing/status", response_model=IndexingStatus)
async def get_indexing_status():
    """Get indexing status"""
    return global_state.indexing_status

@app.post("/indexing/check")
async def check_for_updates():
    """Check if updates are available"""
    if global_state.indexing_status.running:
        return {"status": "running", "message": "Indexing already in progress"}
    
    needs_update, message = global_state.data_manager.check_for_updates()
    return {"needs_update": needs_update, "message": message}

@app.post("/indexing/start")
async def start_indexing(request: IndexingRequest, background_tasks: BackgroundTasks):
    """Start indexing process"""
    if global_state.indexing_status.running:
        return {"status": "running", "message": "Indexing already in progress"}
    
    # Initialize models if not already done
    if not global_state.data_manager.is_initialized:
        global_state.data_manager.initialize_models()
    
    # Start indexing in background
    if request.background:
        background_tasks.add_task(run_indexing, request.force)
        return {"status": "started", "message": "Indexing started in background"}
    else:
        # Run indexing in foreground
        run_indexing(request.force)
        return {"status": "completed", "message": "Indexing completed"}

@app.post("/initialize")
async def initialize_system(force: bool = False, background: bool = True, background_tasks: BackgroundTasks = None):
    """Initialize the system and check environment variables"""
    env_vars = {
        "PAPERLESS_URL": os.getenv("PAPERLESS_URL"),
        "PAPERLESS_NGX_URL": os.getenv("PAPERLESS_NGX_URL"),
        "PAPERLESS_HOST": os.getenv("PAPERLESS_HOST"),
        "PAPERLESS_TOKEN": "[HIDDEN]" if os.getenv("PAPERLESS_TOKEN") else None,
        "PAPERLESS_API_TOKEN": "[HIDDEN]" if os.getenv("PAPERLESS_API_TOKEN") else None,
        "PAPERLESS_APIKEY": "[HIDDEN]" if os.getenv("PAPERLESS_APIKEY") else None
    }
    
    env_file_path = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'data', '.env')
    env_file_exists = os.path.exists(env_file_path)
    
    # Check if indexing is already running
    if global_state.indexing_status.running:
        return {
            "status": "running", 
            "message": "Indexing already in progress",
            "env_file_exists": env_file_exists,
            "env_file_path": env_file_path if env_file_exists else None,
            "environment_variables": env_vars,
            "working_directory": os.getcwd(),
            "config_valid": bool(global_state.data_manager and global_state.data_manager.paperless_url and global_state.data_manager.paperless_token)
        }
    
    # Initialize data manager if needed
    if not global_state.data_manager.is_initialized:
        global_state.data_manager.initialize_models()
    
    # Load documents if needed
    if not global_state.system_status.data_loaded or force:
        global_state.data_manager.load_documents(force_refresh=force)
    
    # Initialize search engine
    if background and background_tasks:
        background_tasks.add_task(run_indexing, force)
        status = "initializing"
        message = "System initialization started in background"
    else:
        run_indexing(force)
        status = "initialized"
        message = "System initialized"
    
    return {
        "status": status, 
        "message": message,
        "data_loaded": global_state.system_status.data_loaded,
        "index_ready": global_state.system_status.index_ready,
        "env_file_exists": env_file_exists,
        "env_file_path": env_file_path if env_file_exists else None,
        "environment_variables": env_vars,
        "working_directory": os.getcwd(),
        "config_valid": bool(global_state.data_manager and global_state.data_manager.paperless_url and global_state.data_manager.paperless_token)
    }

# Main entry point with configuration options
if __name__ == "__main__":
    import argparse
    
    parser = argparse.ArgumentParser(description="RAGZ Document Search API")
    parser.add_argument("--port", type=int, default=8000, help="Port to run the server on")
    parser.add_argument("--host", type=str, default="0.0.0.0", help="Host to run the server on")
    parser.add_argument("--initialize", action="store_true", help="Initialize search engine on startup")
    parser.add_argument("--force-refresh", action="store_true", help="Force refresh documents from API")
    
    args = parser.parse_args()
    
    # If initialization is requested from command line, set this for startup
    if args.initialize:
        logger.info("Auto-initialization requested via command line")
        
        # Will be executed after the app has started
        @app.on_event("startup")
        async def initialize_on_startup():
            logger.info("Running initialization after startup")
            # Give the app time to start
            time.sleep(1)
            # Initialize in background
            run_indexing(args.force_refresh)
    
    uvicorn.run("main:app", host=args.host, port=args.port, reload=False)
