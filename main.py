import os
import json
import logging
import hashlib
import numpy as np
from datetime import datetime
import time
import asyncio
from typing import List, Dict, Optional, Any, Union, Set
import configparser

import requests
import uvicorn
from fastapi import FastAPI, HTTPException, BackgroundTasks
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel, Field
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

# Load configuration from file
config = configparser.ConfigParser()
config.read('rag_config.conf')

# Constants
DOCUMENTS_FILE = config['DEFAULT'].get('DOCUMENTS_FILE', './documents.json')
CHROMADB_DIR = config['DEFAULT'].get('CHROMADB_DIR', './chromadb')
INDEXED_CONF = "./indexed.conf"
EMBEDDING_MODEL_NAME = config['DEFAULT'].get('EMBEDDING_MODEL_NAME', 'paraphrase-multilingual-MiniLM-L12-v2')
CROSS_ENCODER_MODEL_NAME = "cross-encoder/ms-marco-MiniLM-L-6-v2"
COLLECTION_NAME = "documents"
BM25_WEIGHT = float(config['DEFAULT'].get('BM25_WEIGHT', '0.3'))
SEMANTIC_WEIGHT = float(config['DEFAULT'].get('SEMANTIC_WEIGHT', '0.7'))
MAX_RESULTS = int(config['DEFAULT'].get('MAX_RESULTS', '20'))

# Download NLTK resources if not present
nltk.download('punkt', quiet=True)
nltk.download('stopwords', quiet=True)

# Request models
class SearchRequest(BaseModel):
    query: str
    from_date: Optional[str] = None
    to_date: Optional[str] = None
    correspondent: Optional[str] = None

# Response models
class SearchResult(BaseModel):
    title: str
    correspondent: str
    date: str
    score: float
    cross_score: float
    snippet: str
    doc_id: Optional[int] = None

# Status manager for tracking indexing progress
class StatusManager:
    def __init__(self):
        self.indexing_in_progress = False
        self.indexing_complete = False
        self.total_documents = 0
        self.indexed_documents = 0
        self.start_time = None
        self.estimated_completion_time = None
    
    def start_indexing(self, total_docs: int):
        """Start tracking indexing progress"""
        self.indexing_in_progress = True
        self.indexing_complete = False
        self.total_documents = total_docs
        self.indexed_documents = 0
        self.start_time = time.time()
        self.estimated_completion_time = None
        logger.info(f"Starting indexing of {total_docs} documents")
    
    def update_progress(self, indexed_count: int):
        """Update progress with the number of documents indexed so far"""
        self.indexed_documents = indexed_count
        
        # Calculate ETA
        if self.start_time and self.indexed_documents > 0 and self.total_documents > 0:
            elapsed_time = time.time() - self.start_time
            docs_per_second = self.indexed_documents / elapsed_time if elapsed_time > 0 else 0
            remaining_docs = self.total_documents - self.indexed_documents
            
            if docs_per_second > 0:
                remaining_time = remaining_docs / docs_per_second
                self.estimated_completion_time = time.time() + remaining_time
        
        # Log progress
        if self.total_documents > 0:
            progress_pct = (self.indexed_documents / self.total_documents) * 100
            logger.info(f"Indexing progress: {self.indexed_documents}/{self.total_documents} ({progress_pct:.2f}%)")
    
    def complete_indexing(self):
        """Mark indexing as complete"""
        self.indexing_in_progress = False
        self.indexing_complete = True
        self.indexed_documents = self.total_documents
        logger.info("Indexing complete")
    
    def get_progress_percentage(self) -> float:
        """Get progress as a percentage"""
        if self.total_documents == 0:
            return 0.0
        return (self.indexed_documents / self.total_documents) * 100
    
    def get_eta_seconds(self) -> Optional[float]:
        """Get estimated seconds until completion"""
        if self.estimated_completion_time is None:
            return None
        return max(0, self.estimated_completion_time - time.time())
    
    def get_status(self) -> Dict[str, Any]:
        """Get complete status information"""
        eta_seconds = self.get_eta_seconds()
        eta_formatted = None
        
        if eta_seconds is not None:
            minutes, seconds = divmod(int(eta_seconds), 60)
            hours, minutes = divmod(minutes, 60)
            eta_formatted = f"{hours:02d}:{minutes:02d}:{seconds:02d}"
        
        return {
            "indexing_in_progress": self.indexing_in_progress,
            "indexing_complete": self.indexing_complete,
            "idle": not self.indexing_in_progress,
            "total_documents": self.total_documents,
            "indexed_documents": self.indexed_documents,
            "progress": self.get_progress_percentage(),
            "eta_seconds": eta_seconds,
            "eta_formatted": eta_formatted
        }

# Indexed Document Manager
class IndexManager:
    def __init__(self):
        self.indexed_doc_ids = set()
        self.conf_path = INDEXED_CONF
    
    def load_indexed_documents(self) -> Set[int]:
        """Load the set of indexed document IDs from the config file"""
        if not os.path.exists(self.conf_path):
            logger.info(f"No indexed.conf file found at {self.conf_path}")
            return set()
        
        try:
            with open(self.conf_path, 'r', encoding='utf-8') as f:
                indexed_ids = json.load(f)
                # Convert all IDs to integers for consistency
                self.indexed_doc_ids = {int(doc_id) for doc_id in indexed_ids}
                logger.info(f"Loaded {len(self.indexed_doc_ids)} indexed document IDs from {self.conf_path}")
                return self.indexed_doc_ids
        except Exception as e:
            logger.error(f"Error loading indexed document IDs: {str(e)}")
            return set()
    
    def save_indexed_documents(self):
        """Save the current set of indexed document IDs to the config file"""
        try:
            with open(self.conf_path, 'w', encoding='utf-8') as f:
                json.dump(list(self.indexed_doc_ids), f)
            logger.info(f"Saved {len(self.indexed_doc_ids)} indexed document IDs to {self.conf_path}")
        except Exception as e:
            logger.error(f"Error saving indexed document IDs: {str(e)}")
    
    def add_indexed_document(self, doc_id: int):
        """Mark a document as indexed"""
        self.indexed_doc_ids.add(int(doc_id))
    
    def is_document_indexed(self, doc_id: int) -> bool:
        """Check if a document has already been indexed"""
        return int(doc_id) in self.indexed_doc_ids
    
    def get_unindexed_documents(self, documents: List[Dict]) -> List[Dict]:
        """Filter a list of documents to only those that haven't been indexed yet"""
        return [doc for doc in documents if not self.is_document_indexed(doc["id"])]

# Data Manager
class DataManager:
    def __init__(self):
        self.paperless_url = config['DEFAULT'].get('PAPERLESS_URL')
        self.paperless_token = config['DEFAULT'].get('PAPERLESS_TOKEN')
        
        if not self.paperless_url or not self.paperless_token:
            logger.error("Missing PAPERLESS_URL or PAPERLESS_TOKEN in rag_config.conf file")
            raise ValueError("Missing PAPERLESS_URL or PAPERLESS_TOKEN in rag_config.conf file")
        
        self.documents = []
        self.document_hashes = {}
        self.last_sync = None
        
        # Set up ChromaDB
        self.chroma_client = chromadb.PersistentClient(path=CHROMADB_DIR)
        self.sentence_transformer = SentenceTransformer(EMBEDDING_MODEL_NAME)
        self.embedding_function = embedding_functions.SentenceTransformerEmbeddingFunction(
            model_name=EMBEDDING_MODEL_NAME
        )
        
        # Initialize Cross-Encoder
        self.cross_encoder = CrossEncoder(CROSS_ENCODER_MODEL_NAME)
        
        # Initialize index manager
        self.index_manager = IndexManager()
    
    def _get_headers(self):
        return {"Authorization": f"Token {self.paperless_token}"}
    
    def _compute_document_hash(self, doc):
        """Compute a hash for a document to track changes"""
        content = f"{doc['title']}{doc['content']}{doc['correspondent']}"
        return hashlib.sha256(content.encode()).hexdigest()
    
    async def fetch_documents_from_api(self):
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
                logger.info(f"Response headers: {response.headers}")
                
                if response.status_code != 200:
                    logger.error(f"Failed to fetch documents: {response.status_code} - {response.text}")
                    raise Exception(f"API error: {response.status_code} - {response.text}")
                
                # Check if response is empty
                if not response.text:
                    logger.error("API returned empty response")
                    raise Exception("API returned empty response")
                
                # Log the beginning of the response for debugging
                response_preview = response.text[:200] + "..." if len(response.text) > 200 else response.text
                logger.info(f"Response content preview: {response_preview}")
                
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
    
    async def load_documents(self):
        """Load documents from file or API"""
        if os.path.exists(DOCUMENTS_FILE):
            logger.info(f"Loading documents from {DOCUMENTS_FILE}")
            with open(DOCUMENTS_FILE, 'r', encoding='utf-8') as f:
                local_documents = json.load(f)
            
            # Load document hashes
            self.document_hashes = {doc["id"]: doc["hash"] for doc in local_documents if "hash" in doc}
            self.last_sync = datetime.now().isoformat()
            
            # Check for updates if we have internet connection
            try:
                new_documents = await self.fetch_documents_from_api()
                
                # Check for changes
                changes = False
                documents_dict = {doc["id"]: doc for doc in local_documents}
                
                # Process new or updated documents
                for doc in new_documents:
                    doc_id = doc["id"]
                    if doc_id not in documents_dict or doc["hash"] != self.document_hashes.get(doc_id):
                        logger.info(f"Found new or updated document: {doc['title']} (ID: {doc_id})")
                        documents_dict[doc_id] = doc
                        changes = True
                
                if changes:
                    logger.info("Saving updated documents")
                    self.documents = list(documents_dict.values())
                    await self.save_documents()
                    return self.documents
                else:
                    logger.info("No document changes detected")
                    return local_documents
                    
            except Exception as e:
                logger.warning(f"Could not check for updates, using local documents: {str(e)}")
                return local_documents
        else:
            logger.info("No local documents found, fetching from API")
            self.documents = await self.fetch_documents_from_api()
            await self.save_documents()
            return self.documents
    
    async def save_documents(self):
        """Save documents to file"""
        with open(DOCUMENTS_FILE, 'w', encoding='utf-8') as f:
            json.dump(self.documents, f, ensure_ascii=False, indent=2)
        logger.info(f"Saved {len(self.documents)} documents to {DOCUMENTS_FILE}")
    
    async def setup_chroma_collection(self):
        """Set up ChromaDB collection"""
        # Check if collection exists
        try:
            existing_collections = self.chroma_client.list_collections()
            collection_exists = any(c.name == COLLECTION_NAME for c in existing_collections)
            
            if collection_exists:
                collection = self.chroma_client.get_collection(
                    name=COLLECTION_NAME,
                    embedding_function=self.embedding_function
                )
                logger.info(f"Loaded existing ChromaDB collection '{COLLECTION_NAME}'")
                
                # Check if we need to update the collection
                if not self.documents:
                    self.documents = await self.load_documents()
                
                # Load indexed document IDs
                indexed_doc_ids = self.index_manager.load_indexed_documents()
                
                # Get existing IDs in ChromaDB
                existing_ids = collection.get()["ids"]
                existing_ids_set = set(existing_ids)
                
                # Update our index manager with existing IDs
                for doc_id in existing_ids:
                    try:
                        self.index_manager.add_indexed_document(int(doc_id))
                    except ValueError:
                        # Skip if not a valid integer
                        continue
                
                # Find documents to add or update
                docs_to_update = []
                for doc in self.documents:
                    doc_id = str(doc["id"])
                    
                    # If document is not in our indexed set or the hash has changed
                    if not self.index_manager.is_document_indexed(doc["id"]) or \
                       (doc_id in existing_ids_set and self.document_hashes.get(doc["id"]) != doc.get("hash")):
                        docs_to_update.append(doc)
                
                # Update documents if needed
                if docs_to_update:
                    logger.info(f"Updating {len(docs_to_update)} documents in ChromaDB")
                    await self._add_documents_to_chroma(collection, docs_to_update)
                    # Save updated indexed document IDs
                    self.index_manager.save_indexed_documents()
                else:
                    logger.info("No updates needed for ChromaDB collection")
                
                return collection
            else:
                logger.info(f"Creating new ChromaDB collection '{COLLECTION_NAME}'")
                collection = self.chroma_client.create_collection(
                    name=COLLECTION_NAME,
                    embedding_function=self.embedding_function
                )
                
                # Load documents if not already loaded
                if not self.documents:
                    self.documents = await self.load_documents()
                
                # Add all documents to collection with status tracking
                await self._add_documents_to_chroma(collection, self.documents)
                # Save all document IDs as indexed
                self.index_manager.save_indexed_documents()
                return collection
                
        except Exception as e:
            logger.error(f"Error setting up ChromaDB collection: {str(e)}")
            raise
    
    async def _add_documents_to_chroma(self, collection, documents):
        """Add documents to ChromaDB collection with status tracking"""
        # Update status
        status_manager.start_indexing(len(documents))
        
        # We process in batches to avoid memory issues
        batch_size = 100
        total_docs = len(documents)
        processed_docs = 0
        
        for i in range(0, total_docs, batch_size):
            batch = documents[i:i+batch_size]
            batch_size_actual = len(batch)
            logger.info(f"Processing batch {i//batch_size + 1}/{(total_docs-1)//batch_size + 1} ({batch_size_actual} documents)")
            
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
            
            # Mark documents as indexed and update status
            for doc in batch:
                self.index_manager.add_indexed_document(doc["id"])
            
            processed_docs += batch_size_actual
            status_manager.update_progress(processed_docs)
            
            # Small delay to prevent overloading the system
            await asyncio.sleep(0.1)
        
        # Mark indexing as complete
        status_manager.complete_indexing()
        logger.info(f"Added/updated {total_docs} documents to ChromaDB collection")
        
    async def index_documents_background(self):
        """Background task to index documents"""
        try:
            # Always mark indexing as in progress at start
            status_manager.indexing_in_progress = True
            
            # Load the set of already indexed documents first
            indexed_doc_ids = self.index_manager.load_indexed_documents()
            logger.info(f"Loaded {len(indexed_doc_ids)} already indexed document IDs")
            
            # Load documents if not already loaded
            if not self.documents:
                self.documents = await self.load_documents()
            
            # Get only documents that need indexing (not in indexed.conf)
            unindexed_docs = self.index_manager.get_unindexed_documents(self.documents)
            
            if not unindexed_docs:
                logger.info("No new documents to index - all documents already in indexed.conf")
                
                # Set to complete but DON'T overwrite existing chromadb
                logger.info("Marking indexing as complete without re-indexing all documents")
                status_manager.indexing_complete = True
                
                # Create flag file if it doesn't exist
                if not os.path.exists("indexing_complete.flag"):
                    logger.info("Creating indexing_complete.flag")
                    with open("indexing_complete.flag", "w") as f:
                        f.write(datetime.now().isoformat())
                
                return
            
            logger.info(f"Found {len(unindexed_docs)} new documents that need indexing (not in indexed.conf)")
            
            # Get or create the collection - but don't overwrite existing data
            collection = await self.setup_chroma_collection()
            
            # Only index documents that haven't been indexed yet
            logger.info(f"Adding only {len(unindexed_docs)} new documents to ChromaDB")
            await self._add_documents_to_chroma(collection, unindexed_docs)
            
            # Save the updated indexed document IDs
            self.index_manager.save_indexed_documents()
            
            # Make sure to create the completion flag
            with open("indexing_complete.flag", "w") as f:
                f.write(datetime.now().isoformat())
            
        except Exception as e:
            logger.error(f"Error in background indexing task: {str(e)}")
            status_manager.indexing_in_progress = False
            raise


# Search Engine
class SearchEngine:
    def __init__(self, data_manager):
        self.data_manager = data_manager
        self.collection = None
        self.documents = None
        self.bm25 = None
        self.tokenized_corpus = None
    
    async def initialize(self):
        """Initialize search engine"""
        # Load documents if not already loaded
        if not self.data_manager.documents:
            self.documents = await self.data_manager.load_documents()
        else:
            self.documents = self.data_manager.documents
        
        # Set up ChromaDB collection
        self.collection = await self.data_manager.setup_chroma_collection()
        
        # Set up BM25
        logger.info("Initializing BM25 index")
        await self._setup_bm25()
        
        logger.info("Search engine initialized")
    
    async def _setup_bm25(self):
        """Set up BM25 index"""
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
    
    def keyword_search(self, query, top_k=MAX_RESULTS):
        """Perform keyword search using BM25"""
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
    
    async def search(self, request: SearchRequest):
        """Perform full search with filters and reranking"""
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

# FastAPI Application
app = FastAPI(title="RAGZ Document Search API")

# Initialize global status manager
status_manager = StatusManager()

# Add CORS middleware
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# Initialize data manager and search engine
data_manager = None
search_engine = None

@app.on_event("startup")
async def startup_event():
    """Initialize data and search engine on startup"""
    global data_manager, search_engine
    
    logger.info("Starting RAGZ Document Search API")
    
    # Initialize data manager
    data_manager = DataManager()
    
    # 1. Check for all necessary files first
    chromadb_exists = os.path.exists(CHROMADB_DIR) and os.path.isdir(CHROMADB_DIR)
    documents_exists = os.path.exists(DOCUMENTS_FILE)
    flag_exists = os.path.exists('indexing_complete.flag')
    indexed_conf_exists = os.path.exists(INDEXED_CONF)
    
    logger.info(f"Startup check - ChromaDB: {chromadb_exists}, Documents: {documents_exists}, " +
                f"Flag: {flag_exists}, indexed.conf: {indexed_conf_exists}")
    
    # 2. If we have valid index files and a completion flag, mark indexing as complete
    if chromadb_exists and documents_exists and flag_exists:
        logger.info("Found valid index files and completion flag. Marking indexing as complete.")
        status_manager.indexing_complete = True
    
    # 3. Initialize search engine - this loads documents
    search_engine = SearchEngine(data_manager)
    await search_engine.initialize()
    
    # 4. Check indexing status based on what files we have:
    
    # Case 1: If indexed.conf exists - check for new documents that need indexing
    if indexed_conf_exists:
        logger.info("indexed.conf exists - checking for new documents only")
        
        # Load indexed document IDs
        data_manager.index_manager.load_indexed_documents()
        indexed_count = len(data_manager.index_manager.indexed_doc_ids)
        
        # Only start indexing for new unindexed documents
        unindexed_docs = data_manager.index_manager.get_unindexed_documents(data_manager.documents)
        
        if unindexed_docs:
            logger.info(f"Found {len(unindexed_docs)} new documents to index (out of {len(data_manager.documents)} total)")
            # Start background indexing task for new documents only
            asyncio.create_task(data_manager.index_documents_background())
        else:
            logger.info(f"All {indexed_count} documents are already indexed. No re-indexing needed.")
            # Create flag file if not exists
            if not flag_exists:
                with open("indexing_complete.flag", "w") as f:
                    f.write(datetime.now().isoformat())
            status_manager.indexing_complete = True
    
    # Case 2: If we have index files (chromadb/documents.json) but no indexed.conf
    # Create indexed.conf from existing documents to avoid re-indexing
    elif chromadb_exists and documents_exists:
        logger.info("Index files exist but no indexed.conf - creating from existing data")
        
        # Add all document IDs to indexed.conf
        for doc in data_manager.documents:
            data_manager.index_manager.add_indexed_document(doc["id"])
        
        # Save the indexed document IDs
        data_manager.index_manager.save_indexed_documents()
        
        # Create completion flag
        if not flag_exists:
            with open("indexing_complete.flag", "w") as f:
                f.write(datetime.now().isoformat())
        
        status_manager.indexing_complete = True
    
    # Case 3: No valid index files at all - need to start from scratch
    else:
        logger.info("No valid index files found, will create them for new documents only")
        # This will execute only for documents not in indexed.conf (which is empty)
        asyncio.create_task(data_manager.index_documents_background())
    
    logger.info("RAGZ Document Search API ready")

@app.get("/status")
async def get_status():
    """Get current indexing status"""
    if not data_manager or not data_manager.documents:
        return {
            "indexing_in_progress": status_manager.indexing_in_progress,
            "indexing_complete": status_manager.indexing_complete,
            "idle": not status_manager.indexing_in_progress,
            "total_documents": 0,
            "indexed_documents": 0,
            "progress": 0,
            "documents_loaded": False,
            "documents_count": 0,
            "eta_seconds": None,
            "eta_formatted": None,
            "server_running": True
        }
    
    # Get status info
    status_info = status_manager.get_status()
    
    # Add additional information
    status_info["documents_loaded"] = len(data_manager.documents) > 0
    status_info["documents_count"] = len(data_manager.documents)
    status_info["server_running"] = True
    
    return status_info

@app.post("/start-indexing")
async def start_indexing(background_tasks: BackgroundTasks):
    """Start the indexing process in the background"""
    # Check if there's a lock file preventing concurrent indexing
    lock_file_path = 'rag_indexing.lock'
    
    if os.path.exists(lock_file_path):
        # Read the lock file to check if it's stale
        try:
            with open(lock_file_path, 'r') as f:
                lock_time_str = f.read().strip()
                lock_time = datetime.fromisoformat(lock_time_str)
                current_time = datetime.now()
                
                # If lock is older than 10 minutes, consider it stale
                if (current_time - lock_time).total_seconds() > 600:
                    logger.info("Found stale lock file, removing it")
                    os.remove(lock_file_path)
                else:
                    # Lock is recent, indexing is likely in progress
                    return {"status": "already_running", "message": "Indexing is already in progress"}
        except Exception as e:
            logger.error(f"Error reading lock file: {str(e)}")
            # If we can't parse the lock file, assume it's corrupted and remove it
            try:
                os.remove(lock_file_path)
            except:
                pass
    
    # Check if indexing is already running
    if status_manager.indexing_in_progress:
        return {"status": "already_running", "message": "Indexing is already in progress"}
    
    # Create a lock file to prevent concurrent indexing
    try:
        with open(lock_file_path, 'w') as f:
            f.write(datetime.now().isoformat())
    except Exception as e:
        logger.error(f"Error creating lock file: {str(e)}")
    
    # Start background indexing task
    background_tasks.add_task(data_manager.index_documents_background)
    
    return {"status": "started", "message": "Indexing started in the background"}

@app.post("/search", response_model=List[SearchResult])
async def search_documents(request: SearchRequest):
    """Search documents with the given query and filters"""
    try:
        # Check if we have valid indexes
        chromadb_exists = os.path.exists(CHROMADB_DIR) and os.path.isdir(CHROMADB_DIR)
        documents_exists = os.path.exists(DOCUMENTS_FILE)
        flag_exists = os.path.exists('indexing_complete.flag')
        
        # If we have all necessary files, consider indexing complete regardless of status_manager
        if chromadb_exists and documents_exists and flag_exists:
            # Force status_manager to show indexing as complete to allow searching
            if not status_manager.indexing_complete:
                logger.info("Found valid index files but status_manager doesn't show complete. Fixing this.")
                status_manager.indexing_complete = True
        elif not status_manager.indexing_complete:
            # No valid index files and status_manager says not complete
            raise HTTPException(
                status_code=400, 
                detail="Indexing is not complete. Please wait until indexing finishes before searching."
            )
            
        logger.info(f"Search request: {request}")
        return await search_engine.search(request)
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Search error: {str(e)}")
        raise HTTPException(status_code=500, detail=str(e))

# Main entry point
if __name__ == "__main__":
    uvicorn.run("main:app", host="0.0.0.0", port=8000, reload=False)
