//! Restricted `await ronic.*` interpreter.
//!
//! User Code Mode scripts never run in Node or Bun. The host parses a small
//! TypeScript subset and performs each `ronic` call through `dispatch`.

use serde_json::{json, Map, Value};

const MAX_TOKENS: usize = 4_000;
const MAX_STMTS: usize = 80;
const MAX_DEPTH: u32 = 32;

pub fn eval(
    script: &str,
    dispatch: &mut dyn FnMut(&str, &Value) -> Result<Value, String>,
    servers: &[(String, String)],
) -> Result<Value, String> {
    let tokens = tokenize(script)?;
    let mut parser = Parser { tokens, i: 0 };
    let program = parser.parse_program()?;
    let mut env = Map::new();
    let mut last = Value::Null;
    for stmt in program {
        match stmt {
            Stmt::Decl(name, expr) => {
                let value = eval_expr(&expr, &env, dispatch, servers, 0)?;
                env.insert(name, value);
                last = Value::Null;
            }
            Stmt::Expr(expr) => {
                last = eval_expr(&expr, &env, dispatch, servers, 0)?;
            }
            Stmt::Return(expr) => {
                return eval_expr(&expr, &env, dispatch, servers, 0);
            }
        }
    }
    Ok(last)
}

enum Stmt {
    Decl(String, Expr),
    Expr(Expr),
    Return(Expr),
}

enum Expr {
    Null,
    Bool(bool),
    Number(f64),
    String(String),
    Ident(String),
    Array(Vec<Expr>),
    Object(Vec<(String, Expr)>),
    Member(Box<Expr>, String),
    Index(Box<Expr>, Box<Expr>),
    Call(Box<Expr>, Vec<Expr>),
    Await(Box<Expr>),
    Or(Box<Expr>, Box<Expr>),
    And(Box<Expr>, Box<Expr>),
    Eq(Box<Expr>, Box<Expr>),
    Ne(Box<Expr>, Box<Expr>),
    Add(Box<Expr>, Box<Expr>),
    Sub(Box<Expr>, Box<Expr>),
}

enum Token {
    Ident(String),
    Number(f64),
    String(String),
    True,
    False,
    Null,
    Undefined,
    Await,
    Const,
    Let,
    Var,
    Return,
    LParen,
    RParen,
    LBrace,
    RBrace,
    LBracket,
    RBracket,
    Dot,
    Comma,
    Colon,
    Semi,
    Eq,
    EqEq,
    NotEq,
    OrOr,
    AndAnd,
    Plus,
    Minus,
    Star,
    Slash,
    Percent,
    Lt,
    Gt,
    Eof,
}

const FORBIDDEN: &[&str] = &[
    "import",
    "export",
    "function",
    "class",
    "new",
    "eval",
    "debugger",
    "with",
    "while",
    "for",
    "do",
    "switch",
    "try",
    "catch",
    "throw",
    "yield",
    "typeof",
    "delete",
    "void",
    "arguments",
    "this",
    "require",
    "module",
    "exports",
    "globalThis",
    "global",
    "process",
    "Deno",
    "Bun",
    "window",
    "document",
    "fetch",
    "XMLHttpRequest",
    "WebSocket",
    "Function",
    "AsyncFunction",
    "setTimeout",
    "setInterval",
    "importScripts",
    "constructor",
];

fn tokenize(src: &str) -> Result<Vec<Token>, String> {
    let chars: Vec<char> = src.chars().collect();
    let mut i = 0;
    let mut out = Vec::new();
    while i < chars.len() {
        if out.len() > MAX_TOKENS {
            return Err("Code Mode script is too large to interpret.".into());
        }
        let c = chars[i];
        if c.is_whitespace() {
            i += 1;
            continue;
        }
        if c == '/' && i + 1 < chars.len() && chars[i + 1] == '/' {
            i += 2;
            while i < chars.len() && chars[i] != '\n' {
                i += 1;
            }
            continue;
        }
        if c == '/' && i + 1 < chars.len() && chars[i + 1] == '*' {
            i += 2;
            let mut closed = false;
            while i + 1 < chars.len() {
                if chars[i] == '*' && chars[i + 1] == '/' {
                    i += 2;
                    closed = true;
                    break;
                }
                i += 1;
            }
            if !closed {
                return Err("Code Mode script has an unclosed comment.".into());
            }
            continue;
        }
        if c == '`' {
            return Err("Code Mode does not run template strings. Use a plain string.".into());
        }
        if c == '"' || c == '\'' {
            let (s, next) = read_string(&chars, i)?;
            out.push(Token::String(s));
            i = next;
            continue;
        }
        if c.is_ascii_digit() || (c == '.' && i + 1 < chars.len() && chars[i + 1].is_ascii_digit()) {
            let (n, next) = read_number(&chars, i)?;
            out.push(Token::Number(n));
            i = next;
            continue;
        }
        if c == '=' && i + 1 < chars.len() && chars[i + 1] == '>' {
            return Err("Code Mode does not run arrow functions. Use await ronic.* calls and return a value.".into());
        }
        if c.is_ascii_alphabetic() || c == '_' || c == '$' {
            let start = i;
            i += 1;
            while i < chars.len() && (chars[i].is_ascii_alphanumeric() || chars[i] == '_' || chars[i] == '$') {
                i += 1;
            }
            let word: String = chars[start..i].iter().collect();
            out.push(keyword(&word));
            continue;
        }
        match c {
            '(' => out.push(Token::LParen),
            ')' => out.push(Token::RParen),
            '{' => out.push(Token::LBrace),
            '}' => out.push(Token::RBrace),
            '[' => out.push(Token::LBracket),
            ']' => out.push(Token::RBracket),
            '.' => {
                if i + 1 < chars.len() && chars[i + 1] == '?' {
                    return Err("Code Mode does not run optional chaining.".into());
                }
                out.push(Token::Dot);
            }
            ',' => out.push(Token::Comma),
            ':' => out.push(Token::Colon),
            ';' => out.push(Token::Semi),
            '+' => out.push(Token::Plus),
            '-' => out.push(Token::Minus),
            '*' => out.push(Token::Star),
            '/' => out.push(Token::Slash),
            '%' => out.push(Token::Percent),
            '=' => {
                if i + 1 < chars.len() && chars[i + 1] == '=' {
                    i += 1;
                    if i + 1 < chars.len() && chars[i + 1] == '=' {
                        i += 1;
                    }
                    out.push(Token::EqEq);
                } else {
                    out.push(Token::Eq);
                }
            }
            '!' => {
                if i + 1 < chars.len() && chars[i + 1] == '=' {
                    i += 1;
                    if i + 1 < chars.len() && chars[i + 1] == '=' {
                        i += 1;
                    }
                    out.push(Token::NotEq);
                } else {
                    return Err("Code Mode does not run the ! operator.".into());
                }
            }
            '|' => {
                if i + 1 < chars.len() && chars[i + 1] == '|' {
                    i += 1;
                    out.push(Token::OrOr);
                } else {
                    return Err("Code Mode does not run bitwise operators.".into());
                }
            }
            '&' => {
                if i + 1 < chars.len() && chars[i + 1] == '&' {
                    i += 1;
                    out.push(Token::AndAnd);
                } else {
                    return Err("Code Mode does not run bitwise operators.".into());
                }
            }
            '?' => return Err("Code Mode does not run ternary or optional operators.".into()),
            '<' => out.push(Token::Lt),
            '>' => out.push(Token::Gt),
            _ => return Err(format!("Code Mode does not run this syntax: {c}")),
        }
        i += 1;
    }
    out.push(Token::Eof);
    Ok(out)
}

fn keyword(word: &str) -> Token {
    match word {
        "await" => Token::Await,
        "const" => Token::Const,
        "let" => Token::Let,
        "var" => Token::Var,
        "return" => Token::Return,
        "true" => Token::True,
        "false" => Token::False,
        "null" => Token::Null,
        "undefined" => Token::Undefined,
        "async" => Token::Ident("async".into()),
        other => Token::Ident(other.to_string()),
    }
}

fn read_string(chars: &[char], start: usize) -> Result<(String, usize), String> {
    let quote = chars[start];
    let mut i = start + 1;
    let mut out = String::new();
    while i < chars.len() {
        let c = chars[i];
        if c == quote {
            return Ok((out, i + 1));
        }
        if c == '\\' {
            i += 1;
            if i >= chars.len() {
                break;
            }
            out.push(match chars[i] {
                'n' => '\n',
                't' => '\t',
                'r' => '\r',
                '\\' => '\\',
                '"' => '"',
                '\'' => '\'',
                other => other,
            });
            i += 1;
            continue;
        }
        if c == '\n' {
            return Err("Code Mode strings cannot span lines.".into());
        }
        out.push(c);
        i += 1;
    }
    Err("Code Mode script has an unclosed string.".into())
}

fn read_number(chars: &[char], start: usize) -> Result<(f64, usize), String> {
    let mut i = start;
    while i < chars.len() && chars[i].is_ascii_digit() {
        i += 1;
    }
    if i < chars.len() && chars[i] == '.' {
        i += 1;
        while i < chars.len() && chars[i].is_ascii_digit() {
            i += 1;
        }
    }
    let raw: String = chars[start..i].iter().collect();
    raw.parse::<f64>().map(|n| (n, i)).map_err(|_| "Code Mode number is not valid.".into())
}

struct Parser {
    tokens: Vec<Token>,
    i: usize,
}

impl Parser {
    fn parse_program(&mut self) -> Result<Vec<Stmt>, String> {
        let mut stmts = Vec::new();
        while !self.eof() {
            stmts.push(self.parse_stmt()?);
            if stmts.len() > MAX_STMTS {
                return Err("Code Mode script has too many statements.".into());
            }
        }
        if stmts.is_empty() {
            return Err("Code Mode needs at least one statement.".into());
        }
        Ok(stmts)
    }

    fn parse_stmt(&mut self) -> Result<Stmt, String> {
        if matches!(self.peek(), Token::Const | Token::Let | Token::Var) {
            self.i += 1;
            let name = self.expect_ident()?;
            self.skip_ts_type();
            self.expect_eq()?;
            let expr = self.parse_expr()?;
            self.optional_semi();
            return Ok(Stmt::Decl(name, expr));
        }
        if matches!(self.peek(), Token::Return) {
            self.i += 1;
            if self.eof() || matches!(self.peek(), Token::Semi) {
                self.optional_semi();
                return Ok(Stmt::Return(Expr::Null));
            }
            let expr = self.parse_expr()?;
            self.optional_semi();
            return Ok(Stmt::Return(expr));
        }
        if let Token::Ident(name) = self.peek() {
            if FORBIDDEN.contains(&name.as_str()) && name != "constructor" {
                return Err(format!("Code Mode does not run `{name}`. Use await ronic.* calls and return a value."));
            }
        }
        let expr = self.parse_expr()?;
        self.optional_semi();
        Ok(Stmt::Expr(expr))
    }

    fn skip_ts_type(&mut self) {
        if !matches!(self.peek(), Token::Colon) {
            return;
        }
        self.i += 1;
        let mut angle = 0i32;
        let mut paren = 0i32;
        let mut brace = 0i32;
        let mut bracket = 0i32;
        while !self.eof() {
            match self.peek() {
                Token::Eq | Token::Semi if angle == 0 && paren == 0 && brace == 0 && bracket == 0 => return,
                Token::LBrace => brace += 1,
                Token::RBrace => brace -= 1,
                Token::LParen => paren += 1,
                Token::RParen => paren -= 1,
                Token::LBracket => bracket += 1,
                Token::RBracket => bracket -= 1,
                Token::Lt => angle += 1,
                Token::Gt => angle -= 1,
                _ => {}
            }
            self.i += 1;
        }
    }

    fn parse_expr(&mut self) -> Result<Expr, String> {
        self.parse_or()
    }

    fn parse_or(&mut self) -> Result<Expr, String> {
        let mut left = self.parse_and()?;
        while matches!(self.peek(), Token::OrOr) {
            self.i += 1;
            let right = self.parse_and()?;
            left = Expr::Or(Box::new(left), Box::new(right));
        }
        Ok(left)
    }

    fn parse_and(&mut self) -> Result<Expr, String> {
        let mut left = self.parse_eq()?;
        while matches!(self.peek(), Token::AndAnd) {
            self.i += 1;
            let right = self.parse_eq()?;
            left = Expr::And(Box::new(left), Box::new(right));
        }
        Ok(left)
    }

    fn parse_eq(&mut self) -> Result<Expr, String> {
        let mut left = self.parse_add()?;
        loop {
            match self.peek() {
                Token::EqEq => {
                    self.i += 1;
                    let right = self.parse_add()?;
                    left = Expr::Eq(Box::new(left), Box::new(right));
                }
                Token::NotEq => {
                    self.i += 1;
                    let right = self.parse_add()?;
                    left = Expr::Ne(Box::new(left), Box::new(right));
                }
                _ => break,
            }
        }
        Ok(left)
    }

    fn parse_add(&mut self) -> Result<Expr, String> {
        let mut left = self.parse_unary()?;
        loop {
            match self.peek() {
                Token::Plus => {
                    self.i += 1;
                    let right = self.parse_unary()?;
                    left = Expr::Add(Box::new(left), Box::new(right));
                }
                Token::Minus => {
                    self.i += 1;
                    let right = self.parse_unary()?;
                    left = Expr::Sub(Box::new(left), Box::new(right));
                }
                Token::Star | Token::Slash | Token::Percent | Token::Lt | Token::Gt => {
                    return Err("Code Mode does not run that operator. Use await ronic.* calls and return a value.".into());
                }
                _ => break,
            }
        }
        Ok(left)
    }

    fn parse_unary(&mut self) -> Result<Expr, String> {
        if matches!(self.peek(), Token::Await) {
            self.i += 1;
            return Ok(Expr::Await(Box::new(self.parse_unary()?)));
        }
        if matches!(self.peek(), Token::Minus) {
            self.i += 1;
            return Ok(Expr::Sub(Box::new(Expr::Number(0.0)), Box::new(self.parse_unary()?)));
        }
        self.parse_postfix()
    }

    fn parse_postfix(&mut self) -> Result<Expr, String> {
        let mut expr = self.parse_primary()?;
        loop {
            match self.peek() {
                Token::Dot => {
                    self.i += 1;
                    let name = self.expect_ident()?;
                    expr = Expr::Member(Box::new(expr), name);
                }
                Token::LBracket => {
                    self.i += 1;
                    let index = self.parse_expr()?;
                    self.expect(Token::RBracket, "missing ]")?;
                    expr = Expr::Index(Box::new(expr), Box::new(index));
                }
                Token::LParen => {
                    self.i += 1;
                    let args = self.parse_args()?;
                    expr = Expr::Call(Box::new(expr), args);
                }
                Token::Ident(name) if name == "as" => {
                    self.i += 1;
                    self.skip_as_type();
                }
                _ => break,
            }
        }
        Ok(expr)
    }

    fn skip_as_type(&mut self) {
        if matches!(self.peek(), Token::Ident(_)) {
            self.i += 1;
        }
        while matches!(self.peek(), Token::LBracket) {
            self.i += 1;
            if matches!(self.peek(), Token::RBracket) {
                self.i += 1;
            } else {
                break;
            }
        }
    }

    fn parse_primary(&mut self) -> Result<Expr, String> {
        match self.peek() {
            Token::True => {
                self.i += 1;
                Ok(Expr::Bool(true))
            }
            Token::False => {
                self.i += 1;
                Ok(Expr::Bool(false))
            }
            Token::Null | Token::Undefined => {
                self.i += 1;
                Ok(Expr::Null)
            }
            Token::Number(n) => {
                let n = *n;
                self.i += 1;
                Ok(Expr::Number(n))
            }
            Token::String(s) => {
                let s = s.clone();
                self.i += 1;
                Ok(Expr::String(s))
            }
            Token::Ident(name) => {
                let name = name.clone();
                self.i += 1;
                Ok(Expr::Ident(name))
            }
            Token::LBracket => {
                self.i += 1;
                let mut items = Vec::new();
                while !self.eof() && !matches!(self.peek(), Token::RBracket) {
                    items.push(self.parse_expr()?);
                    if matches!(self.peek(), Token::Comma) {
                        self.i += 1;
                    } else {
                        break;
                    }
                }
                self.expect(Token::RBracket, "missing ]")?;
                Ok(Expr::Array(items))
            }
            Token::LBrace => {
                self.i += 1;
                let mut fields = Vec::new();
                while !self.eof() && !matches!(self.peek(), Token::RBrace) {
                    let key = match self.peek() {
                        Token::Ident(name) | Token::String(name) => {
                            let key = name.clone();
                            self.i += 1;
                            key
                        }
                        _ => return Err("Code Mode object keys must be names or strings.".into()),
                    };
                    self.expect(Token::Colon, "object field needs a colon")?;
                    let value = self.parse_expr()?;
                    fields.push((key, value));
                    if matches!(self.peek(), Token::Comma) {
                        self.i += 1;
                    } else {
                        break;
                    }
                }
                self.expect(Token::RBrace, "missing }")?;
                Ok(Expr::Object(fields))
            }
            Token::LParen => {
                self.i += 1;
                let expr = self.parse_expr()?;
                self.expect(Token::RParen, "missing )")?;
                Ok(expr)
            }
            Token::Eof => Err("Code Mode script ended in the middle of an expression.".into()),
            _ => Err("Code Mode only runs await ronic.* TypeScript, assignments, and return.".into()),
        }
    }

    fn parse_args(&mut self) -> Result<Vec<Expr>, String> {
        let mut args = Vec::new();
        while !self.eof() && !matches!(self.peek(), Token::RParen) {
            args.push(self.parse_expr()?);
            if matches!(self.peek(), Token::Comma) {
                self.i += 1;
            } else {
                break;
            }
        }
        self.expect(Token::RParen, "missing )")?;
        Ok(args)
    }

    fn peek(&self) -> &Token {
        self.tokens.get(self.i).unwrap_or(&Token::Eof)
    }

    fn eof(&self) -> bool {
        matches!(self.peek(), Token::Eof)
    }

    fn optional_semi(&mut self) {
        if matches!(self.peek(), Token::Semi) {
            self.i += 1;
        }
    }

    fn expect_ident(&mut self) -> Result<String, String> {
        match self.peek() {
            Token::Ident(name) => {
                let name = name.clone();
                self.i += 1;
                Ok(name)
            }
            _ => Err("Code Mode expected a name.".into()),
        }
    }

    fn expect_eq(&mut self) -> Result<(), String> {
        if matches!(self.peek(), Token::Eq) {
            self.i += 1;
            Ok(())
        } else {
            Err("Code Mode assignment needs =.".into())
        }
    }

    fn expect(&mut self, want: Token, msg: &str) -> Result<(), String> {
        if std::mem::discriminant(self.peek()) == std::mem::discriminant(&want) {
            self.i += 1;
            Ok(())
        } else {
            Err(msg.into())
        }
    }
}

enum Runtime {
    Json(Value),
    Ronic(Vec<String>),
}

fn eval_expr(
    expr: &Expr,
    env: &Map<String, Value>,
    dispatch: &mut dyn FnMut(&str, &Value) -> Result<Value, String>,
    servers: &[(String, String)],
    depth: u32,
) -> Result<Value, String> {
    if depth > MAX_DEPTH {
        return Err("Code Mode expression is too nested.".into());
    }
    match eval_runtime(expr, env, dispatch, servers, depth)? {
        Runtime::Json(value) => Ok(value),
        Runtime::Ronic(path) => Err(format!("`{}` is a binding. Call it as a function.", path.join("."))),
    }
}

fn eval_runtime(
    expr: &Expr,
    env: &Map<String, Value>,
    dispatch: &mut dyn FnMut(&str, &Value) -> Result<Value, String>,
    servers: &[(String, String)],
    depth: u32,
) -> Result<Runtime, String> {
    if depth > MAX_DEPTH {
        return Err("Code Mode expression is too nested.".into());
    }
    match expr {
        Expr::Null => Ok(Runtime::Json(Value::Null)),
        Expr::Bool(v) => Ok(Runtime::Json(Value::Bool(*v))),
        Expr::Number(n) => Ok(Runtime::Json(json!(n))),
        Expr::String(s) => Ok(Runtime::Json(Value::String(s.clone()))),
        Expr::Ident(name) => {
            if name == "ronic" {
                return Ok(Runtime::Ronic(vec!["ronic".into()]));
            }
            if FORBIDDEN.contains(&name.as_str()) {
                return Err(format!("Code Mode does not expose `{name}`."));
            }
            env.get(name).cloned().map(Runtime::Json).ok_or_else(|| format!("`{name}` is not defined in this Code Mode script."))
        }
        Expr::Array(items) => {
            let mut out = Vec::new();
            for item in items {
                out.push(eval_expr(item, env, dispatch, servers, depth + 1)?);
            }
            Ok(Runtime::Json(Value::Array(out)))
        }
        Expr::Object(fields) => {
            let mut out = Map::new();
            for (key, value) in fields {
                out.insert(key.clone(), eval_expr(value, env, dispatch, servers, depth + 1)?);
            }
            Ok(Runtime::Json(Value::Object(out)))
        }
        Expr::Member(base, name) => match eval_runtime(base, env, dispatch, servers, depth + 1)? {
            Runtime::Ronic(mut path) => {
                path.push(name.clone());
                Ok(Runtime::Ronic(path))
            }
            Runtime::Json(value) => Ok(Runtime::Json(json_member(&value, name))),
        },
        Expr::Index(base, index) => {
            let index = eval_expr(index, env, dispatch, servers, depth + 1)?;
            match eval_runtime(base, env, dispatch, servers, depth + 1)? {
                Runtime::Ronic(_) => Err("Code Mode ronic paths use dot names, not brackets.".into()),
                Runtime::Json(value) => Ok(Runtime::Json(json_index(&value, &index))),
            }
        }
        Expr::Call(callee, args) => {
            let mut values = Vec::new();
            for arg in args {
                values.push(eval_expr(arg, env, dispatch, servers, depth + 1)?);
            }
            match eval_runtime(callee, env, dispatch, servers, depth + 1)? {
                Runtime::Ronic(path) => {
                    let value = ronic_call(&path, &values, dispatch, servers)?;
                    Ok(Runtime::Json(value))
                }
                Runtime::Json(_) => Err("Code Mode only calls ronic.* functions.".into()),
            }
        }
        Expr::Await(inner) => eval_runtime(inner, env, dispatch, servers, depth + 1),
        Expr::Or(left, right) => {
            let left = eval_expr(left, env, dispatch, servers, depth + 1)?;
            if truthy(&left) {
                Ok(Runtime::Json(left))
            } else {
                Ok(Runtime::Json(eval_expr(right, env, dispatch, servers, depth + 1)?))
            }
        }
        Expr::And(left, right) => {
            let left = eval_expr(left, env, dispatch, servers, depth + 1)?;
            if !truthy(&left) {
                Ok(Runtime::Json(left))
            } else {
                Ok(Runtime::Json(eval_expr(right, env, dispatch, servers, depth + 1)?))
            }
        }
        Expr::Eq(left, right) => {
            let left = eval_expr(left, env, dispatch, servers, depth + 1)?;
            let right = eval_expr(right, env, dispatch, servers, depth + 1)?;
            Ok(Runtime::Json(Value::Bool(left == right)))
        }
        Expr::Ne(left, right) => {
            let left = eval_expr(left, env, dispatch, servers, depth + 1)?;
            let right = eval_expr(right, env, dispatch, servers, depth + 1)?;
            Ok(Runtime::Json(Value::Bool(left != right)))
        }
        Expr::Add(left, right) => {
            let left = eval_expr(left, env, dispatch, servers, depth + 1)?;
            let right = eval_expr(right, env, dispatch, servers, depth + 1)?;
            Ok(Runtime::Json(add_values(&left, &right)))
        }
        Expr::Sub(left, right) => {
            let left = eval_expr(left, env, dispatch, servers, depth + 1)?;
            let right = eval_expr(right, env, dispatch, servers, depth + 1)?;
            let a = as_f64(&left).ok_or_else(|| "Code Mode subtraction needs numbers.".to_string())?;
            let b = as_f64(&right).ok_or_else(|| "Code Mode subtraction needs numbers.".to_string())?;
            Ok(Runtime::Json(json!(a - b)))
        }
    }
}

fn json_member(value: &Value, name: &str) -> Value {
    if name == "length" {
        return match value {
            Value::Array(items) => json!(items.len() as f64),
            Value::String(text) => json!(text.chars().count() as f64),
            Value::Object(map) => json!(map.len() as f64),
            _ => Value::Null,
        };
    }
    value.get(name).cloned().unwrap_or(Value::Null)
}

fn json_index(value: &Value, index: &Value) -> Value {
    if let Some(n) = as_f64(index) {
        let i = n as usize;
        return match value {
            Value::Array(items) => items.get(i).cloned().unwrap_or(Value::Null),
            Value::String(text) => text.chars().nth(i).map(|c| Value::String(c.to_string())).unwrap_or(Value::Null),
            _ => Value::Null,
        };
    }
    if let Some(key) = index.as_str() {
        return json_member(value, key);
    }
    Value::Null
}

fn truthy(value: &Value) -> bool {
    match value {
        Value::Null => false,
        Value::Bool(v) => *v,
        Value::Number(n) => n.as_f64().map(|v| v != 0.0 && !v.is_nan()).unwrap_or(false),
        Value::String(s) => !s.is_empty(),
        Value::Array(_) | Value::Object(_) => true,
    }
}

fn as_f64(value: &Value) -> Option<f64> {
    match value {
        Value::Number(n) => n.as_f64(),
        _ => None,
    }
}

fn add_values(left: &Value, right: &Value) -> Value {
    if let (Some(a), Some(b)) = (as_f64(left), as_f64(right)) {
        return json!(a + b);
    }
    Value::String(format!("{}{}", display(left), display(right)))
}

fn display(value: &Value) -> String {
    match value {
        Value::Null => "null".into(),
        Value::Bool(v) => v.to_string(),
        Value::Number(n) => n.to_string(),
        Value::String(s) => s.clone(),
        other => other.to_string(),
    }
}

fn ronic_call(
    path: &[String],
    args: &[Value],
    dispatch: &mut dyn FnMut(&str, &Value) -> Result<Value, String>,
    servers: &[(String, String)],
) -> Result<Value, String> {
    if path.first().map(String::as_str) != Some("ronic") {
        return Err("Code Mode only calls ronic.* functions.".into());
    }
    let rest: Vec<&str> = path.iter().skip(1).map(String::as_str).collect();
    match rest.as_slice() {
        ["mem0", "search"] => dispatch("mem0.search", &json!({ "query": arg_string(args, 0) })),
        ["mem0", "add"] => dispatch(
            "mem0.add",
            &json!({
                "fact": arg_string(args, 0),
                "title": args.get(1).and_then(|v| v.get("title")).and_then(|v| v.as_str()).unwrap_or("")
            }),
        ),
        ["mem0", "graphNeighbors"] => dispatch("mem0.graphNeighbors", &json!({ "entity": arg_string(args, 0) })),
        ["skills", "listIndex"] => dispatch("skills.listIndex", &json!({})),
        ["skills", "loadPlaybook"] => dispatch("skills.loadPlaybook", &json!({ "slug": arg_string(args, 0) })),
        ["mcp", "searchCapabilities"] => dispatch("mcp.searchCapabilities", &json!({ "query": arg_string(args, 0) })),
        ["mcp", "call"] => dispatch(
            "mcp.call",
            &json!({
                "server": arg_string(args, 0),
                "tool": arg_string(args, 1),
                "params": args.get(2).cloned().unwrap_or_else(|| json!({}))
            }),
        ),
        ["mcp", "workspace", "searchMemory"] => dispatch(
            "mcp.call",
            &json!({ "server": "ronic-os", "tool": "search_memory", "params": { "query": arg_string(args, 0) } }),
        ),
        ["mcp", "workspace", "listSkills"] => dispatch("mcp.call", &json!({ "server": "ronic-os", "tool": "list_skills", "params": {} })),
        ["mcp", "workspace", "loadSkill"] => {
            dispatch("mcp.call", &json!({ "server": "ronic-os", "tool": "load_skill", "params": { "slug": arg_string(args, 0) } }))
        }
        ["mcp", "workspace", "listPlugins"] => dispatch("mcp.call", &json!({ "server": "ronic-os", "tool": "list_plugins", "params": {} })),
        ["mcp", ident, tool] => {
            let server = servers
                .iter()
                .find(|(id, name)| id == ident || name.eq_ignore_ascii_case(ident))
                .map(|(_, name)| name.clone())
                .unwrap_or_else(|| (*ident).to_string());
            dispatch(
                "mcp.call",
                &json!({
                    "server": server,
                    "tool": *tool,
                    "params": args.first().cloned().unwrap_or_else(|| json!({}))
                }),
            )
        }
        ["acp", "askPeer"] => dispatch("acp.askPeer", &json!({ "target": arg_string(args, 0), "prompt": arg_string(args, 1) })),
        _ => Err(format!("`{}` is not an Ronic Code Mode binding.", path.join("."))),
    }
}

fn arg_string(args: &[Value], index: usize) -> String {
    match args.get(index) {
        Some(Value::String(s)) => s.clone(),
        Some(Value::Null) | None => String::new(),
        Some(other) => other.to_string(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn run(script: &str) -> Result<Value, String> {
        let mut calls = Vec::new();
        eval(
            script,
            &mut |method, args| {
                calls.push(method.to_string());
                match method {
                    "skills.listIndex" => Ok(json!([{ "slug": "demo", "slash": "/demo", "summary": "s" }])),
                    "mem0.search" => Ok(json!([{ "title": args["query"], "excerpt": "note" }])),
                    _ => Ok(json!({ "method": method, "args": args })),
                }
            },
            &[],
        )
    }

    #[test]
    fn sample_script_returns_counts() {
        let value = run(
            r#"
            const skills = await ronic.skills.listIndex();
            const facts = await ronic.mem0.search("workspace");
            return { skillCount: skills.length, factCount: facts.length, first: skills[0] || null };
            "#,
        )
        .unwrap();
        assert_eq!(value["skillCount"], 1.0);
        assert_eq!(value["factCount"], 1.0);
        assert_eq!(value["first"]["slug"], "demo");
    }

    #[test]
    fn refuses_eval_and_process() {
        assert!(run("return eval('1')").is_err());
        assert!(run("return process.env").is_err());
        assert!(run("new Function('return 1')()").is_err());
        assert!(run("import fs from 'fs'").is_err());
    }

    #[test]
    fn unknown_ronic_path_fails() {
        let error = run("return await ronic.shell.exec('dir')").unwrap_err();
        assert!(error.contains("not an Ronic Code Mode binding"), "{error}");
    }
}
