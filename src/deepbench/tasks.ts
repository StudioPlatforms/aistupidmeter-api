export interface DeepStep {
  id: string;
  prompt: (ctx: { nonce: string; prev?: any; artifacts?: any[] }) => string;
  maxTokens?: number;
  temperature?: number;
  judge?: 'code_tests' | 'doc_qa_match' | 'rule_memory' | 'plan_coherence' | 'none';
  expectsFeedback?: boolean;
}

export interface DeepTask {
  slug: string;
  description: string;
  providerAllow: ('openai' | 'anthropic' | 'google' | 'xai' | 'deepseek' | 'glm' | 'kimi')[];
  steps: DeepStep[];
  resources?: {
    initialFiles?: Record<string, string>;
    unitTests?: string;
    document?: string;
    requirements?: string[];
    targetArchitecture?: string;
  };
  scoring: {
    weights: {
      correctness: number;
      complexity: number;
      codeQuality: number;
      efficiency: number;
      stability: number;
      edgeCases: number;
      debugging: number;
      format: number;
      safety: number;
      // New deep-specific axes
      memoryRetention: number;
      hallucinationRate: number;
      planCoherence: number;
      contextWindow: number;
    };
  };
}

// Shared Python scaffolds for tasks
const ECOMMERCE_CART_FILES = {
  'main.py': `# E-commerce cart system - has 3 subtle bugs that need fixing
from typing import List, Dict, Optional
from dataclasses import dataclass
import json

@dataclass
class Product:
    id: str
    name: str
    price: float
    stock: int

@dataclass
class CartItem:
    product_id: str
    quantity: int
    
class ShoppingCart:
    def __init__(self):
        self.items: Dict[str, CartItem] = {}
        self.discount_code: Optional[str] = None
    
    def add_item(self, product_id: str, quantity: int = 1):
        """Add item to cart"""
        if product_id in self.items:
            self.items[product_id].quantity += quantity  # Bug 1: No stock validation
        else:
            self.items[product_id] = CartItem(product_id, quantity)
    
    def remove_item(self, product_id: str, quantity: int = 1):
        """Remove item from cart"""
        if product_id not in self.items:
            return False
        
        if self.items[product_id].quantity <= quantity:
            del self.items[product_id]
        else:
            self.items[product_id].quantity -= quantity
        return True
    
    def get_total(self, products: List[Product]) -> float:
        """Calculate cart total"""
        total = 0.0
        product_dict = {p.id: p for p in products}
        
        for item in self.items.values():
            if item.product_id in product_dict:
                product = product_dict[item.product_id]
                total += product.price * item.quantity  # Bug 2: No stock check here
        
        # Bug 3: Discount logic is wrong - should be percentage, not fixed amount
        if self.discount_code == "SAVE10":
            total -= 10.0
        
        return total
    
    def validate_cart(self, products: List[Product]) -> List[str]:
        """Validate cart against product availability"""
        errors = []
        product_dict = {p.id: p for p in products}
        
        for item in self.items.values():
            if item.product_id not in product_dict:
                errors.append(f"Product {item.product_id} not found")
            elif product_dict[item.product_id].stock < item.quantity:
                errors.append(f"Insufficient stock for {item.product_id}")
        
        return errors
`,

  'test_cart.py': `import pytest
from main import ShoppingCart, Product, CartItem

def test_add_item_basic():
    """Test basic item addition"""
    cart = ShoppingCart()
    cart.add_item("P1", 2)
    assert "P1" in cart.items
    assert cart.items["P1"].quantity == 2

def test_add_item_duplicate():
    """Test adding same item multiple times"""
    cart = ShoppingCart()
    cart.add_item("P1", 2)
    cart.add_item("P1", 3)
    assert cart.items["P1"].quantity == 5

def test_remove_item():
    """Test item removal"""
    cart = ShoppingCart()
    cart.add_item("P1", 5)
    result = cart.remove_item("P1", 2)
    assert result == True
    assert cart.items["P1"].quantity == 3

def test_get_total():
    """Test total calculation"""
    products = [
        Product("P1", "Widget", 10.0, 100),
        Product("P2", "Gadget", 20.0, 50)
    ]
    cart = ShoppingCart()
    cart.add_item("P1", 2)
    cart.add_item("P2", 1)
    
    total = cart.get_total(products)
    assert total == 40.0  # 2*10 + 1*20

def test_discount_code():
    """Test discount application"""
    products = [Product("P1", "Widget", 100.0, 10)]
    cart = ShoppingCart()
    cart.add_item("P1", 1)
    cart.discount_code = "SAVE10"
    
    total = cart.get_total(products)
    assert total == 90.0  # Should be 10% off, not $10 off

def test_validate_cart():
    """Test cart validation against stock"""
    products = [Product("P1", "Widget", 10.0, 5)]
    cart = ShoppingCart()
    cart.add_item("P1", 10)  # More than stock
    
    errors = cart.validate_cart(products)
    assert len(errors) > 0
    assert "Insufficient stock" in errors[0]
`
};

const REST_API_REQUIREMENTS = [
  "JWT authentication with refresh tokens - tokens expire in 1 hour",
  "Rate limiting: 100 requests per hour per authenticated user, 10 per hour for unauthenticated",
  "Input validation with specific error codes: 400001 for missing fields, 400002 for invalid format",
  "Pagination with cursor-based navigation - max 50 items per page",
  "Error responses must include timestamp, error code, message, and request_id",
  "All endpoints must support JSON only - no XML or form data",
  "User roles: 'admin', 'user', 'readonly' - admins can access all data",
  "Database migrations must be reversible and include rollback instructions",
  "API versioning in URL path: /api/v1/ - maintain backward compatibility",
  "Request/response logging with correlation IDs for debugging"
];

const TECHNICAL_DOCUMENTATION = `
# TechCorp API Documentation v2.1

## Authentication System

### JWT Token Format
- **Access Token**: Expires in 60 minutes
- **Refresh Token**: Expires in 30 days
- **Token Header**: Must include "Bearer " prefix
- **Scope Required**: All endpoints require 'api:read' minimum

### Rate Limiting Policies
Premium users: 1000 requests/hour
Standard users: 100 requests/hour  
Free tier: 10 requests/hour

Rate limit headers returned:
- X-RateLimit-Limit: Your rate limit
- X-RateLimit-Remaining: Requests remaining
- X-RateLimit-Reset: Unix timestamp when limit resets

## Webhook System (Section 4.3)

### Webhook Retry Logic
Failed webhooks are retried with exponential backoff:
1. Immediate retry
2. 1 minute delay
3. 5 minute delay  
4. 30 minute delay
5. 2 hour delay (final attempt)

Webhook timeouts: 30 seconds maximum
Required response: HTTP 200-299 status code

### Webhook Security
- All webhook payloads signed with HMAC-SHA256
- Signature in X-Signature header  
- Verify signature before processing payload
- Webhook URLs must use HTTPS

## API Deprecation Timeline

### Version 1.x Deprecation
- **Announcement**: January 15, 2024
- **Support End**: July 15, 2024  
- **Shutdown**: January 15, 2025

All v1.x users must migrate to v2.0+ by July 2024.
Migration guide available at /docs/migration/v1-to-v2

### Breaking Changes in v2.0
- Timestamp format changed from epoch to ISO8601
- Error code format changed from string to integer
- User ID format changed from integer to UUID

## Data Retention Policies

### User Data
- Active users: Data retained indefinitely
- Inactive users (12+ months): Data archived after 18 months
- Deleted accounts: Data permanently deleted after 30 days

### Log Data  
- API request logs: 90 days retention
- Error logs: 1 year retention
- Security logs: 7 years retention (compliance requirement)

## Premium Features

### Advanced Analytics
Premium users get access to:
- Real-time dashboard updates
- Custom report generation
- Historical data beyond 90 days
- API usage analytics with granular breakdowns

### Priority Support
- Guaranteed 2-hour response time
- Direct access to senior engineers
- Custom integration assistance
- Performance optimization consultations
`;

export const DEEP_TASKS: DeepTask[] = [
  {
    slug: 'deep/ide_assistant',
    description: 'Multi-turn debugging session: Fix e-commerce cart bugs with iterative feedback',
    providerAllow: ['openai', 'anthropic', 'google', 'xai', 'deepseek', 'glm', 'kimi'],
    resources: {
      initialFiles: ECOMMERCE_CART_FILES
    },
    steps: [
      {
        id: 'analyze_code',
        prompt: ({ nonce }) => `You are helping debug a Python e-commerce cart system. Here are the files:

MAIN.PY:
${ECOMMERCE_CART_FILES['main.py']}

TEST_CART.PY:
${ECOMMERCE_CART_FILES['test_cart.py']}

Analyze this code and identify any bugs you can spot. Don't fix them yet - just describe what issues you see and where they are located. Session ID: ${nonce}`,
        maxTokens: 800,
        judge: 'none',
        expectsFeedback: true
      },
      {
        id: 'run_tests',
        prompt: () => `I ran the tests and got these failures:

FAILED test_cart.py::test_discount_code - AssertionError: assert 90.0 == 90.0
FAILED test_cart.py::test_validate_cart - AssertionError: assert 1 > 0

The discount test expects 90.0 but gets 90.0 (this is confusing - the test logic might be wrong).
The validation test fails because no errors are being caught properly.

Please fix the first bug you identified. Show me the corrected code for just the part you're changing.`,
        maxTokens: 600,
        judge: 'code_tests',
        expectsFeedback: true
      },
      {
        id: 'fix_discount',
        prompt: ({ prev }) => `Good progress! Now I need you to fix the discount logic. The current system subtracts $10, but "SAVE10" should be a 10% discount. 

Here's what the test expects:
- Cart total before discount: $100  
- After "SAVE10" code: $90 (10% off)

Please fix the get_total method's discount logic. Remember the other fixes you made earlier.`,
        maxTokens: 500,
        judge: 'code_tests',
        expectsFeedback: true
      },
      {
        id: 'fix_validation',
        prompt: () => `There's still an issue with the validate_cart method. When I add 10 items but only 5 are in stock, the validation should catch this, but it's not working properly.

Look at the add_item and validate_cart methods. The problem is that we're not checking stock when adding items. Fix this issue.`,
        maxTokens: 600,
        judge: 'code_tests',
        expectsFeedback: true
      },
      {
        id: 'comprehensive_test',
        prompt: () => `Great! Now let's test the complete system. I want you to write a comprehensive test that:

1. Creates products with limited stock
2. Adds items that would exceed stock limits  
3. Validates the cart catches the stock issue
4. Tests the discount code works correctly
5. Verifies the total calculation is right

Write a single test function that covers all these scenarios and demonstrates your fixes work together.`,
        maxTokens: 700,
        judge: 'code_tests'
      }
    ],
    scoring: {
      weights: {
        correctness: 0.30,
        complexity: 0.10,
        codeQuality: 0.10,
        efficiency: 0.05,
        stability: 0.05,
        edgeCases: 0.10,
        debugging: 0.15,  // High weight for debugging task
        format: 0.05,
        safety: 0.05,
        memoryRetention: 0.15,  // Remembers previous fixes
        hallucinationRate: 0.10,  // No invented APIs
        planCoherence: 0.10,  // Consistent debugging approach
        contextWindow: 0.05
      }
    }
  },

  {
    slug: 'deep/spec_follow',
    description: 'Build REST API following detailed requirements across multiple turns',
    providerAllow: ['openai', 'anthropic', 'google', 'xai', 'deepseek', 'glm', 'kimi'],
    resources: {
      requirements: REST_API_REQUIREMENTS,
      unitTests: `
import importlib, types, time
# The model must provide a module named auth or app with these functions.
M = None
for name in ("auth", "app", "main"):
    try:
        M = importlib.import_module(name)
        break
    except Exception:
        pass
assert M is not None, "Expected module auth/app/main with auth functions"

assert hasattr(M, "generate_access_token"), "missing generate_access_token"
assert hasattr(M, "generate_refresh_token"), "missing generate_refresh_token"
assert hasattr(M, "decode_token"), "missing decode_token function"

# Generate tokens
acc = M.generate_access_token({"sub":"u1","scope":"api:read"})
ref = M.generate_refresh_token({"sub":"u1"})

# Test token expiry
decoded = M.decode_token(acc)
assert "exp" in decoded, "access token must have exp field"
now = int(time.time())
assert decoded["exp"] - now <= 3600+5, f"access token must expire ~3600s, got {decoded['exp'] - now}s"

# Test rate limiting headers
rl = getattr(M, "rate_limit_headers", lambda tier: {})("standard")
assert "X-RateLimit-Limit" in rl and int(rl["X-RateLimit-Limit"])==100, f"rate limit mismatch, got {rl}"

# Test error response format
e = getattr(M, "error_response", lambda code,msg,rid: {})(400001, "missing fields", "req-1")
assert isinstance(e, dict) and e.get("code")==400001 and "timestamp" in e and "request_id" in e, f"error payload format wrong: {e}"

print("✅ All spec_follow tests passed")
`
    },
    steps: [
      {
        id: 'architecture_plan',
        prompt: ({ nonce }) => `You need to build a REST API that meets these requirements:

${REST_API_REQUIREMENTS.map((req, i) => `${i + 1}. ${req}`).join('\n')}

First, create an architecture plan. Describe:
1. What framework/libraries you'll use
2. How you'll structure the code
3. Database schema considerations
4. Authentication flow design

Don't write code yet - just plan the architecture. Session: ${nonce}`,
        maxTokens: 1000,
        judge: 'plan_coherence',
        expectsFeedback: true
      },
      {
        id: 'auth_implementation',
        prompt: ({ artifacts }) => `Good plan! Now implement the authentication system first. Based on your architecture plan, create:

1. JWT token generation and validation functions
2. Refresh token handling
3. User role checking middleware  
4. Rate limiting implementation

Remember: tokens expire in 1 hour, refresh tokens in 30 days, and we need the specific error codes (400001, 400002).

Export your functions in app.py or auth.py - tests will import your module by those names.`,
        maxTokens: 1200,
        judge: 'code_tests',
        expectsFeedback: true
      },
      {
        id: 'api_endpoints',
        prompt: () => `Now create the core API endpoints. Implement:

1. POST /api/v1/auth/login - returns JWT + refresh token
2. POST /api/v1/auth/refresh - exchanges refresh token for new access token  
3. GET /api/v1/users - with pagination (cursor-based, max 50 items)
4. GET /api/v1/users/{id} - single user lookup

All endpoints must follow the error response format and include proper validation.`,
        maxTokens: 1400,
        judge: 'code_tests',
        expectsFeedback: true
      },
      {
        id: 'error_handling',
        prompt: () => `I tested your endpoints and they work, but the error handling needs improvement. Make sure:

1. Error responses include timestamp, error code, message, and request_id
2. Use the specific error codes: 400001 for missing fields, 400002 for invalid format
3. Rate limiting returns proper headers (X-RateLimit-*)
4. JSON-only responses (reject XML/form data with proper error)

Update your error handling middleware and test it.`,
        maxTokens: 800,
        judge: 'code_tests',
        expectsFeedback: true
      },
      {
        id: 'integration_test',
        prompt: () => `Perfect! Now write an integration test that demonstrates the complete flow:

1. User registration/login
2. Getting JWT tokens
3. Making authenticated requests
4. Hitting rate limits
5. Using refresh tokens
6. Testing admin vs user roles

The test should verify all requirements are working together properly.`,
        maxTokens: 1000,
        judge: 'code_tests'
      }
    ],
    scoring: {
      weights: {
        correctness: 0.25,
        complexity: 0.15,  // Complex multi-component system
        codeQuality: 0.15,
        efficiency: 0.05,
        stability: 0.10,
        edgeCases: 0.10,
        debugging: 0.05,
        format: 0.05,
        safety: 0.10,  // Security is important for auth
        memoryRetention: 0.20,  // Must remember all requirements
        hallucinationRate: 0.10,
        planCoherence: 0.20,  // Consistent architecture decisions
        contextWindow: 0.10
      }
    }
  },

  {
    slug: 'deep/doc_memory',
    description: 'Answer chained questions from large technical documentation',
    providerAllow: ['openai', 'anthropic', 'google', 'xai', 'deepseek', 'glm', 'kimi'],
    resources: {
      document: TECHNICAL_DOCUMENTATION
    },
    steps: [
      {
        id: 'initial_questions',
        prompt: ({ nonce }) => `Please read this technical documentation carefully:

${TECHNICAL_DOCUMENTATION}

Now answer these questions based ONLY on the information in the documentation:

1. What are the rate limits for premium users?
2. How long do JWT access tokens last?
3. What HTTP response codes indicate successful webhook delivery?

Be precise and cite the relevant sections. Session: ${nonce}`,
        maxTokens: 600,
        judge: 'doc_qa_match',
        expectsFeedback: true
      },
      {
        id: 'webhook_details',
        prompt: () => `Based on the same documentation, explain the webhook retry mechanism mentioned in section 4.3:

1. How many retry attempts are made?
2. What are the exact delay intervals?
3. What's the maximum timeout for webhook responses?
4. How are webhook payloads secured?

Reference the specific section where you found each answer.`,
        maxTokens: 700,
        judge: 'doc_qa_match',
        expectsFeedback: true
      },
      {
        id: 'deprecation_timeline',
        prompt: () => `Earlier in our conversation, we discussed rate limits. Now I need information about API deprecation:

1. When was the v1.x deprecation announced?
2. What's the final shutdown date for v1.x?
3. What are the 3 breaking changes in v2.0?

Remember to stay consistent with the rate limit information you provided earlier.`,
        maxTokens: 600,
        judge: 'doc_qa_match',
        expectsFeedback: true
      },
      {
        id: 'cross_reference',
        prompt: () => `Now I need you to connect information from different sections. Based on what you've told me about:
- Premium user rate limits (from earlier)  
- Webhook retry logic
- Data retention policies

Answer: If a premium user's webhook fails all retry attempts, how long will the error logs about those failures be kept according to the documentation?`,
        maxTokens: 400,
        judge: 'doc_qa_match',
        expectsFeedback: true
      },
      {
        id: 'comprehensive_summary',
        prompt: () => `Finally, create a summary that demonstrates you remember all the key points we've discussed:

1. Premium user capabilities (rate limits + features)
2. Security measures (JWT + webhooks)  
3. Timeline information (deprecation + retention)
4. System constraints (timeouts + limits)

This should be a cohesive summary showing how all pieces fit together.`,
        maxTokens: 800,
        judge: 'doc_qa_match'
      }
    ],
    scoring: {
      weights: {
        correctness: 0.25,
        complexity: 0.05,  // Reading comprehension task
        codeQuality: 0.05,
        efficiency: 0.05,
        stability: 0.05,
        edgeCases: 0.05,
        debugging: 0.05,
        format: 0.10,
        safety: 0.05,
        memoryRetention: 0.30,  // Critical for this task
        hallucinationRate: 0.25,  // Must not invent facts
        planCoherence: 0.10,
        contextWindow: 0.15  // Effective use of long document
      }
    }
  },

  {
    slug: 'deep/refactor_project',
    description: 'Refactor monolithic application to microservices architecture',
    providerAllow: ['openai', 'anthropic', 'google', 'xai', 'deepseek', 'glm', 'kimi'],
    resources: {
      initialFiles: {
        'monolith.py': `# Monolithic application that needs refactoring
import sqlite3
import hashlib
import json
from datetime import datetime
from typing import Dict, List, Optional

class UserManager:
    def __init__(self, db_path: str):
        self.db_path = db_path
        self.init_db()
    
    def init_db(self):
        conn = sqlite3.connect(self.db_path)
        conn.execute('''CREATE TABLE IF NOT EXISTS users 
                       (id INTEGER PRIMARY KEY, username TEXT, password_hash TEXT,
                        email TEXT, created_at TEXT)''')
        conn.execute('''CREATE TABLE IF NOT EXISTS sessions
                       (session_id TEXT PRIMARY KEY, user_id INTEGER, created_at TEXT)''')
        conn.execute('''CREATE TABLE IF NOT EXISTS orders
                       (id INTEGER PRIMARY KEY, user_id INTEGER, product_id INTEGER,
                        quantity INTEGER, total REAL, created_at TEXT)''')
        conn.execute('''CREATE TABLE IF NOT EXISTS products
                       (id INTEGER PRIMARY KEY, name TEXT, price REAL, stock INTEGER)''')
        conn.close()
    
    def create_user(self, username: str, password: str, email: str) -> int:
        password_hash = hashlib.sha256(password.encode()).hexdigest()
        conn = sqlite3.connect(self.db_path)
        cursor = conn.cursor()
        cursor.execute("INSERT INTO users (username, password_hash, email, created_at) VALUES (?, ?, ?, ?)",
                      (username, password_hash, email, datetime.now().isoformat()))
        user_id = cursor.lastrowid
        conn.commit()
        conn.close()
        return user_id
    
    def authenticate_user(self, username: str, password: str) -> Optional[int]:
        password_hash = hashlib.sha256(password.encode()).hexdigest()
        conn = sqlite3.connect(self.db_path)
        cursor = conn.cursor()
        cursor.execute("SELECT id FROM users WHERE username = ? AND password_hash = ?",
                      (username, password_hash))
        result = cursor.fetchone()
        conn.close()
        return result[0] if result else None
    
    def create_session(self, user_id: int) -> str:
        session_id = hashlib.md5(f"{user_id}{datetime.now()}".encode()).hexdigest()
        conn = sqlite3.connect(self.db_path)
        conn.execute("INSERT INTO sessions (session_id, user_id, created_at) VALUES (?, ?, ?)",
                    (session_id, user_id, datetime.now().isoformat()))
        conn.commit()
        conn.close()
        return session_id
    
    def get_user_from_session(self, session_id: str) -> Optional[int]:
        conn = sqlite3.connect(self.db_path)
        cursor = conn.cursor()
        cursor.execute("SELECT user_id FROM sessions WHERE session_id = ?", (session_id,))
        result = cursor.fetchone()
        conn.close()
        return result[0] if result else None
    
    def add_product(self, name: str, price: float, stock: int) -> int:
        conn = sqlite3.connect(self.db_path)
        cursor = conn.cursor()
        cursor.execute("INSERT INTO products (name, price, stock) VALUES (?, ?, ?)",
                      (name, price, stock))
        product_id = cursor.lastrowid
        conn.commit()
        conn.close()
        return product_id
    
    def get_product(self, product_id: int) -> Optional[Dict]:
        conn = sqlite3.connect(self.db_path)
        cursor = conn.cursor()
        cursor.execute("SELECT id, name, price, stock FROM products WHERE id = ?", (product_id,))
        result = cursor.fetchone()
        conn.close()
        if result:
            return {"id": result[0], "name": result[1], "price": result[2], "stock": result[3]}
        return None
    
    def create_order(self, user_id: int, product_id: int, quantity: int) -> int:
        # This method does too many things - violates single responsibility
        product = self.get_product(product_id)
        if not product or product["stock"] < quantity:
            raise ValueError("Insufficient stock")
        
        total = product["price"] * quantity
        
        # Update stock
        conn = sqlite3.connect(self.db_path)
        conn.execute("UPDATE products SET stock = stock - ? WHERE id = ?", (quantity, product_id))
        
        # Create order
        cursor = conn.cursor()
        cursor.execute("INSERT INTO orders (user_id, product_id, quantity, total, created_at) VALUES (?, ?, ?, ?, ?)",
                      (user_id, product_id, quantity, total, datetime.now().isoformat()))
        order_id = cursor.lastrowid
        conn.commit()
        conn.close()
        
        return order_id
    
    def get_user_orders(self, user_id: int) -> List[Dict]:
        conn = sqlite3.connect(self.db_path)
        cursor = conn.cursor()
        cursor.execute('''SELECT o.id, o.product_id, p.name, o.quantity, o.total, o.created_at
                         FROM orders o JOIN products p ON o.product_id = p.id 
                         WHERE o.user_id = ?''', (user_id,))
        results = cursor.fetchall()
        conn.close()
        
        orders = []
        for row in results:
            orders.append({
                "id": row[0],
                "product_id": row[1], 
                "product_name": row[2],
                "quantity": row[3],
                "total": row[4],
                "created_at": row[5]
            })
        return orders

# Usage example - everything mixed together
if __name__ == "__main__":
    manager = UserManager("app.db")
    
    # User management
    user_id = manager.create_user("john_doe", "password123", "john@example.com")
    session_id = manager.create_session(user_id)
    
    # Product management  
    product_id = manager.add_product("Widget", 19.99, 100)
    
    # Order processing
    order_id = manager.create_order(user_id, product_id, 2)
    orders = manager.get_user_orders(user_id)
    
    print(f"Created order {order_id} for user {user_id}")
`
      },
      targetArchitecture: 'Split into user_service, auth_service, product_service, order_service'
    },
    steps: [
      {
        id: 'analysis',
        prompt: ({ nonce }) => `You need to refactor this monolithic Python application into microservices. Here's the current code:

\`\`\`python
# Monolithic application that needs refactoring
import sqlite3
import hashlib
import json
from datetime import datetime
from typing import Dict, List, Optional

class UserManager:
    def __init__(self, db_path: str):
        self.db_path = db_path
        self.init_db()
    
    def init_db(self):
        conn = sqlite3.connect(self.db_path)
        conn.execute('''CREATE TABLE IF NOT EXISTS users 
                       (id INTEGER PRIMARY KEY, username TEXT, password_hash TEXT,
                        email TEXT, created_at TEXT)''')
        conn.execute('''CREATE TABLE IF NOT EXISTS sessions
                       (session_id TEXT PRIMARY KEY, user_id INTEGER, created_at TEXT)''')
        conn.execute('''CREATE TABLE IF NOT EXISTS orders
                       (id INTEGER PRIMARY KEY, user_id INTEGER, product_id INTEGER,
                        quantity INTEGER, total REAL, created_at TEXT)''')
        conn.execute('''CREATE TABLE IF NOT EXISTS products
                       (id INTEGER PRIMARY KEY, name TEXT, price REAL, stock INTEGER)''')
        conn.close()
    
    def create_user(self, username: str, password: str, email: str) -> int:
        password_hash = hashlib.sha256(password.encode()).hexdigest()
        conn = sqlite3.connect(self.db_path)
        cursor = conn.cursor()
        cursor.execute("INSERT INTO users (username, password_hash, email, created_at) VALUES (?, ?, ?, ?)",
                      (username, password_hash, email, datetime.now().isoformat()))
        user_id = cursor.lastrowid
        conn.commit()
        conn.close()
        return user_id
    
    def authenticate_user(self, username: str, password: str) -> Optional[int]:
        password_hash = hashlib.sha256(password.encode()).hexdigest()
        conn = sqlite3.connect(self.db_path)
        cursor = conn.cursor()
        cursor.execute("SELECT id FROM users WHERE username = ? AND password_hash = ?",
                      (username, password_hash))
        result = cursor.fetchone()
        conn.close()
        return result[0] if result else None
    
    def create_session(self, user_id: int) -> str:
        session_id = hashlib.md5(f"{user_id}{datetime.now()}".encode()).hexdigest()
        conn = sqlite3.connect(self.db_path)
        conn.execute("INSERT INTO sessions (session_id, user_id, created_at) VALUES (?, ?, ?)",
                    (session_id, user_id, datetime.now().isoformat()))
        conn.commit()
        conn.close()
        return session_id
    
    def get_user_from_session(self, session_id: str) -> Optional[int]:
        conn = sqlite3.connect(self.db_path)
        cursor = conn.cursor()
        cursor.execute("SELECT user_id FROM sessions WHERE session_id = ?", (session_id,))
        result = cursor.fetchone()
        conn.close()
        return result[0] if result else None
    
    def add_product(self, name: str, price: float, stock: int) -> int:
        conn = sqlite3.connect(self.db_path)
        cursor = conn.cursor()
        cursor.execute("INSERT INTO products (name, price, stock) VALUES (?, ?, ?)",
                      (name, price, stock))
        product_id = cursor.lastrowid
        conn.commit()
        conn.close()
        return product_id
    
    def get_product(self, product_id: int) -> Optional[Dict]:
        conn = sqlite3.connect(self.db_path)
        cursor = conn.cursor()
        cursor.execute("SELECT id, name, price, stock FROM products WHERE id = ?", (product_id,))
        result = cursor.fetchone()
        conn.close()
        if result:
            return {"id": result[0], "name": result[1], "price": result[2], "stock": result[3]}
        return None
    
    def create_order(self, user_id: int, product_id: int, quantity: int) -> int:
        # This method does too many things - violates single responsibility
        product = self.get_product(product_id)
        if not product or product["stock"] < quantity:
            raise ValueError("Insufficient stock")
        
        total = product["price"] * quantity
        
        # Update stock
        conn = sqlite3.connect(self.db_path)
        conn.execute("UPDATE products SET stock = stock - ? WHERE id = ?", (quantity, product_id))
        
        # Create order
        cursor = conn.cursor()
        cursor.execute("INSERT INTO orders (user_id, product_id, quantity, total, created_at) VALUES (?, ?, ?, ?, ?)",
                      (user_id, product_id, quantity, total, datetime.now().isoformat()))
        order_id = cursor.lastrowid
        conn.commit()
        conn.close()
        
        return order_id
    
    def get_user_orders(self, user_id: int) -> List[Dict]:
        conn = sqlite3.connect(self.db_path)
        cursor = conn.cursor()
        cursor.execute('''SELECT o.id, o.product_id, p.name, o.quantity, o.total, o.created_at
                         FROM orders o JOIN products p ON o.product_id = p.id 
                         WHERE o.user_id = ?''', (user_id,))
        results = cursor.fetchall()
        conn.close()
        
        orders = []
        for row in results:
            orders.append({
                "id": row[0],
                "product_id": row[1], 
                "product_name": row[2],
                "quantity": row[3],
                "total": row[4],
                "created_at": row[5]
            })
        return orders
\`\`\`

Analyze the monolith and identify:
1. What are the main responsibilities mixed together?
2. What services should this be split into?  
3. What are the data boundaries between services?
4. What challenges will arise during the refactoring?

Don't write code yet - just analyze and plan. Session: ${nonce}`,
        maxTokens: 900,
        judge: 'plan_coherence',
        expectsFeedback: true
      },
      {
        id: 'user_service',
        prompt: () => `Good analysis! Now create the User Service first. This should handle:
- User registration and management
- User data storage
- User lookup operations

Extract the user-related functionality from the monolith and create a clean, focused service. Include proper error handling and a simple API interface.`,
        maxTokens: 1000,
        judge: 'code_tests',
        expectsFeedback: true
      },
      {
        id: 'auth_service',
        prompt: () => `Now create the Authentication Service. This should be separate from User Service and handle:
- User login/logout
- Session management  
- Authentication validation

Remember to make it work with the User Service you just created. How will these services communicate?`,
        maxTokens: 900,
        judge: 'code_tests',
        expectsFeedback: true
      },
      {
        id: 'product_service',
        prompt: () => `Create the Product Service to manage:
- Product catalog
- Inventory management
- Product lookups

This should be completely independent from user/auth services. Consider how inventory updates will work across service boundaries.`,
        maxTokens: 800,
        judge: 'code_tests',
        expectsFeedback: true
      },
      {
        id: 'order_service',
        prompt: () => `Finally, create the Order Service. This is the most complex because it needs to:
- Coordinate with Product Service for inventory
- Coordinate with User Service for validation  
- Handle order creation and management
- Maintain data consistency

Show how this service will interact with the others you've created. What happens if the Product Service is unavailable?`,
        maxTokens: 1200,
        judge: 'code_tests',
        expectsFeedback: true
      },
      {
        id: 'integration',
        prompt: () => `Excellent! Now demonstrate how all services work together. Create:

1. A simple orchestration layer that coordinates the services
2. A test scenario that shows: user registration → login → create order
3. Error handling when services are unavailable
4. How data consistency is maintained across services

Show that your microservices architecture provides the same functionality as the original monolith but with better separation of concerns.`,
        maxTokens: 1100,
        judge: 'code_tests'
      }
    ],
    scoring: {
      weights: {
        correctness: 0.20,
        complexity: 0.20,  // Complex architectural task
        codeQuality: 0.15,
        efficiency: 0.05,
        stability: 0.10,
        edgeCases: 0.10,
        debugging: 0.05,
        format: 0.05,
        safety: 0.05,
        memoryRetention: 0.15,  // Must remember service boundaries
        hallucinationRate: 0.05,
        planCoherence: 0.25,  // Consistent architecture across turns
        contextWindow: 0.10
      }
    }
  }
];
