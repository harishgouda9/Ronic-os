//! Restricted host-v2 interpreter for `await ronic.*` scripts.
//!
//! User Code Mode scripts never run in Node or Bun. The host parses a small
//! TypeScript subset: assignments, if/else, bounded for-of, comparisons,
//! template strings, nullish `??`, Object.keys/values/entries, and array or
//! string methods. Each `ronic` call goes through `dispatch`.

use serde_json::{json, Map, Value};
use std::collections::HashSet;

const MAX_TOKENS: usize = 4_000;
const MAX_STMTS: usize = 80;
const MAX_DEPTH: u32 = 32;
const MAX_LOOP: u32 = 64;
const MAX_CALLBACKS: u32 = 64;
const MAX_SPLIT: usize = 64;

pub fn eval(
    script: &str,
    dispatch: &mut dyn FnMut(&str, &Value) -> Result<Value, String>,
    servers: &[(String, String)],
) -> Result<Value, String> {
    let tokens = tokenize(script)?;
    let mut parser = Parser { tokens, i: 0, stmts: 0 };
    let program = parser.parse_program()?;
    let mut env = Env::new();
    let mut budget = Budget { callbacks: 0, loops: 0 };
    let mut last = Value::Null;
    for stmt in program {
        match eval_stmt(&stmt, &mut env, dispatch, servers, &mut budget, 0)? {
            Flow::Next(value) => last = value,
            Flow::Return(value) => return Ok(value),
        }
    }
    Ok(last)
}

enum Stmt {
    Empty,
    Decl { name: String, expr: Expr, is_const: bool },
    DeclObject { fields: Vec<(String, String)>, expr: Expr, is_const: bool },
    DeclArray { names: Vec<String>, expr: Expr, is_const: bool },
    Assign(String, Expr),
    Expr(Expr),
    Return(Expr),
    Block(Vec<Stmt>),
    If(Expr, Box<Stmt>, Option<Box<Stmt>>),
    ForOf { name: String, is_const: bool, iter: Expr, body: Box<Stmt> },
}

enum Expr {
    Null,
    Bool(bool),
    Number(f64),
    String(String),
    Template(Vec<TSeg>),
    Ident(String),
    Array(Vec<Expr>),
    Object(Vec<(String, Expr)>),
    Member(Box<Expr>, String),
    OptionalMember(Box<Expr>, String),
    Index(Box<Expr>, Box<Expr>),
    OptionalIndex(Box<Expr>, Box<Expr>),
    Call(Box<Expr>, Vec<Expr>),
    Await(Box<Expr>),
    Not(Box<Expr>),
    Or(Box<Expr>, Box<Expr>),
    And(Box<Expr>, Box<Expr>),
    Nullish(Box<Expr>, Box<Expr>),
    Eq(Box<Expr>, Box<Expr>),
    Ne(Box<Expr>, Box<Expr>),
    Lt(Box<Expr>, Box<Expr>),
    Gt(Box<Expr>, Box<Expr>),
    Le(Box<Expr>, Box<Expr>),
    Ge(Box<Expr>, Box<Expr>),
    Add(Box<Expr>, Box<Expr>),
    Sub(Box<Expr>, Box<Expr>),
    Mul(Box<Expr>, Box<Expr>),
    Div(Box<Expr>, Box<Expr>),
    Mod(Box<Expr>, Box<Expr>),
    Ternary(Box<Expr>, Box<Expr>, Box<Expr>),
    Arrow { params: Vec<String>, body: ArrowBody },
}

enum ArrowBody {
    Expr(Box<Expr>),
    Return(Box<Expr>),
}

enum TSeg {
    Text(String),
    Expr(Expr),
}

#[derive(Clone)]
enum TemplatePiece {
    Text(String),
    Expr(String),
}

enum Token {
    Ident(String),
    Number(f64),
    String(String),
    Template(Vec<TemplatePiece>),
    True,
    False,
    Null,
    Undefined,
    Await,
    Const,
    Let,
    Var,
    Return,
    If,
    Else,
    For,
    Arrow,
    LParen,
    RParen,
    LBrace,
    RBrace,
    LBracket,
    RBracket,
    Dot,
    OptionalDot,
    Comma,
    Colon,
    Semi,
    Eq,
    EqEq,
    NotEq,
    Not,
    Question,
    Nullish,
    OrOr,
    AndAnd,
    Plus,
    Minus,
    Star,
    Slash,
    Percent,
    Lt,
    Gt,
    Le,
    Ge,
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
            let (parts, next) = read_template(&chars, i)?;
            out.push(Token::Template(parts));
            i = next;
            continue;
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
            ',' => out.push(Token::Comma),
            ':' => out.push(Token::Colon),
            ';' => out.push(Token::Semi),
            '+' => out.push(Token::Plus),
            '-' => out.push(Token::Minus),
            '*' => out.push(Token::Star),
            '/' => out.push(Token::Slash),
            '%' => out.push(Token::Percent),
            '?' => {
                if i + 1 < chars.len() && chars[i + 1] == '?' {
                    out.push(Token::Nullish);
                    i += 2;
                    continue;
                }
                if i + 1 < chars.len() && chars[i + 1] == '.' {
                    out.push(Token::OptionalDot);
                    i += 2;
                    continue;
                }
                out.push(Token::Question);
            }
            '.' => out.push(Token::Dot),
            '=' => {
                if i + 1 < chars.len() && chars[i + 1] == '>' {
                    out.push(Token::Arrow);
                    i += 2;
                    continue;
                }
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
                    out.push(Token::Not);
                }
            }
            '|' => {
                if i + 1 < chars.len() && chars[i + 1] == '|' {
                    out.push(Token::OrOr);
                    i += 1;
                } else {
                    return Err("Code Mode does not run bitwise operators.".into());
                }
            }
            '&' => {
                if i + 1 < chars.len() && chars[i + 1] == '&' {
                    out.push(Token::AndAnd);
                    i += 1;
                } else {
                    return Err("Code Mode does not run bitwise operators.".into());
                }
            }
            '<' => {
                if i + 1 < chars.len() && chars[i + 1] == '=' {
                    out.push(Token::Le);
                    i += 1;
                } else {
                    out.push(Token::Lt);
                }
            }
            '>' => {
                if i + 1 < chars.len() && chars[i + 1] == '=' {
                    out.push(Token::Ge);
                    i += 1;
                } else {
                    out.push(Token::Gt);
                }
            }
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
        "if" => Token::If,
        "else" => Token::Else,
        "for" => Token::For,
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

fn read_template(chars: &[char], start: usize) -> Result<(Vec<TemplatePiece>, usize), String> {
    let mut i = start + 1;
    let mut parts = Vec::new();
    let mut buf = String::new();
    while i < chars.len() {
        if chars[i] == '\\' {
            i += 1;
            if i >= chars.len() {
                break;
            }
            buf.push(match chars[i] {
                'n' => '\n',
                't' => '\t',
                'r' => '\r',
                '\\' => '\\',
                '`' => '`',
                '$' => '$',
                other => other,
            });
            i += 1;
            continue;
        }
        if chars[i] == '`' {
            parts.push(TemplatePiece::Text(buf));
            return Ok((parts, i + 1));
        }
        if chars[i] == '$' && i + 1 < chars.len() && chars[i + 1] == '{' {
            parts.push(TemplatePiece::Text(std::mem::take(&mut buf)));
            i += 2;
            let expr_start = i;
            i = skip_template_expr(chars, i)?;
            let expr: String = chars[expr_start..i].iter().collect();
            if i >= chars.len() || chars[i] != '}' {
                return Err("Code Mode template interpolation is unclosed.".into());
            }
            i += 1;
            parts.push(TemplatePiece::Expr(expr));
            continue;
        }
        buf.push(chars[i]);
        i += 1;
    }
    Err("Code Mode script has an unclosed template string.".into())
}

fn skip_template_expr(chars: &[char], mut i: usize) -> Result<usize, String> {
    let mut depth = 1i32;
    while i < chars.len() && depth > 0 {
        if chars[i] == '"' || chars[i] == '\'' {
            let (_, next) = read_string(chars, i)?;
            i = next;
            continue;
        }
        if chars[i] == '`' {
            let (_, next) = read_template(chars, i)?;
            i = next;
            continue;
        }
        if chars[i] == '/' && i + 1 < chars.len() && chars[i + 1] == '/' {
            i += 2;
            while i < chars.len() && chars[i] != '\n' {
                i += 1;
            }
            continue;
        }
        if chars[i] == '{' {
            depth += 1;
            i += 1;
            continue;
        }
        if chars[i] == '}' {
            depth -= 1;
            if depth == 0 {
                return Ok(i);
            }
            i += 1;
            continue;
        }
        i += 1;
    }
    Err("Code Mode template interpolation is unclosed.".into())
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
    stmts: usize,
}

impl Parser {
    fn parse_program(&mut self) -> Result<Vec<Stmt>, String> {
        let mut stmts = Vec::new();
        while !self.eof() {
            stmts.push(self.parse_stmt()?);
        }
        if stmts.is_empty() || stmts.iter().all(|stmt| matches!(stmt, Stmt::Empty)) {
            return Err("Code Mode needs at least one statement.".into());
        }
        Ok(stmts)
    }

    fn parse_stmt(&mut self) -> Result<Stmt, String> {
        if matches!(self.peek(), Token::Semi) {
            self.i += 1;
            return Ok(Stmt::Empty);
        }
        self.bump()?;
        if matches!(self.peek(), Token::LBrace) {
            return self.parse_block();
        }
        if matches!(self.peek(), Token::If) {
            self.i += 1;
            return self.parse_if();
        }
        if matches!(self.peek(), Token::For) {
            self.i += 1;
            return self.parse_for();
        }
        if matches!(self.peek(), Token::Else) {
            return Err("Code Mode else needs an if.".into());
        }
        if matches!(self.peek(), Token::Const | Token::Let | Token::Var) {
            let is_const = matches!(self.peek(), Token::Const);
            self.i += 1;
            return self.parse_binding(is_const);
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
            if FORBIDDEN.contains(&name.as_str()) {
                let name = name.clone();
                return Err(format!("Code Mode does not run `{name}`. Use await ronic.* calls and return a value."));
            }
            if matches!(self.peek_at(1), Token::Eq) {
                let name = name.clone();
                self.i += 2;
                let expr = self.parse_expr()?;
                self.optional_semi();
                return Ok(Stmt::Assign(name, expr));
            }
        }
        let expr = self.parse_expr()?;
        if matches!(self.peek(), Token::Eq) {
            return Err("Code Mode only assigns to a let name.".into());
        }
        self.optional_semi();
        Ok(Stmt::Expr(expr))
    }

    fn parse_block(&mut self) -> Result<Stmt, String> {
        self.expect(Token::LBrace, "missing {")?;
        let mut stmts = Vec::new();
        while !self.eof() && !matches!(self.peek(), Token::RBrace) {
            stmts.push(self.parse_stmt()?);
        }
        self.expect(Token::RBrace, "missing }")?;
        Ok(Stmt::Block(stmts))
    }

    fn parse_if(&mut self) -> Result<Stmt, String> {
        self.expect(Token::LParen, "missing (")?;
        let cond = self.parse_expr()?;
        self.expect(Token::RParen, "missing )")?;
        let then_stmt = self.parse_stmt()?;
        let else_stmt = if matches!(self.peek(), Token::Else) {
            self.i += 1;
            Some(Box::new(self.parse_stmt()?))
        } else {
            None
        };
        Ok(Stmt::If(cond, Box::new(then_stmt), else_stmt))
    }

    fn parse_for(&mut self) -> Result<Stmt, String> {
        self.expect(Token::LParen, "missing (")?;
        let is_const = match self.peek() {
            Token::Const => {
                self.i += 1;
                true
            }
            Token::Let | Token::Var => {
                self.i += 1;
                false
            }
            _ => return Err("Code Mode for loops only run for-of.".into()),
        };
        let name = self.expect_ident()?;
        let kw = self.expect_ident()?;
        if kw != "of" {
            return Err("Code Mode for loops only run for-of.".into());
        }
        let iter = self.parse_expr()?;
        self.expect(Token::RParen, "missing )")?;
        let body = self.parse_stmt()?;
        Ok(Stmt::ForOf { name, is_const, iter, body: Box::new(body) })
    }

    fn parse_binding(&mut self, is_const: bool) -> Result<Stmt, String> {
        if matches!(self.peek(), Token::LBrace) {
            let fields = self.parse_object_pattern()?;
            self.skip_ts_type();
            self.expect_eq()?;
            let expr = self.parse_expr()?;
            self.optional_semi();
            return Ok(Stmt::DeclObject { fields, expr, is_const });
        }
        if matches!(self.peek(), Token::LBracket) {
            let names = self.parse_array_pattern()?;
            self.skip_ts_type();
            self.expect_eq()?;
            let expr = self.parse_expr()?;
            self.optional_semi();
            return Ok(Stmt::DeclArray { names, expr, is_const });
        }
        let name = self.expect_ident()?;
        self.skip_ts_type();
        self.expect_eq()?;
        let expr = self.parse_expr()?;
        self.optional_semi();
        Ok(Stmt::Decl { name, expr, is_const })
    }

    fn parse_object_pattern(&mut self) -> Result<Vec<(String, String)>, String> {
        self.expect(Token::LBrace, "missing {")?;
        let mut fields = Vec::new();
        while !self.eof() && !matches!(self.peek(), Token::RBrace) {
            if matches!(self.peek(), Token::Dot) {
                return Err("Code Mode destructuring does not use rest.".into());
            }
            let key = match self.peek() {
                Token::Ident(name) | Token::String(name) => {
                    let key = name.clone();
                    self.i += 1;
                    key
                }
                _ => return Err("Code Mode object patterns need names.".into()),
            };
            reject_prop(&key)?;
            let local = if matches!(self.peek(), Token::Colon) {
                self.i += 1;
                self.expect_ident()?
            } else {
                key.clone()
            };
            if matches!(self.peek(), Token::Eq) {
                return Err("Code Mode destructuring does not use defaults.".into());
            }
            fields.push((key, local));
            if matches!(self.peek(), Token::Comma) {
                self.i += 1;
            } else {
                break;
            }
        }
        self.expect(Token::RBrace, "missing }")?;
        if fields.is_empty() {
            return Err("Code Mode destructuring needs a name.".into());
        }
        Ok(fields)
    }

    fn parse_array_pattern(&mut self) -> Result<Vec<String>, String> {
        self.expect(Token::LBracket, "missing ]")?;
        let mut names = Vec::new();
        while !self.eof() && !matches!(self.peek(), Token::RBracket) {
            if matches!(self.peek(), Token::Dot) {
                return Err("Code Mode destructuring does not use rest.".into());
            }
            if matches!(self.peek(), Token::Comma) {
                return Err("Code Mode destructuring does not use holes.".into());
            }
            names.push(self.expect_ident()?);
            if matches!(self.peek(), Token::Eq) {
                return Err("Code Mode destructuring does not use defaults.".into());
            }
            if matches!(self.peek(), Token::Comma) {
                self.i += 1;
            } else {
                break;
            }
        }
        self.expect(Token::RBracket, "missing ]")?;
        if names.is_empty() {
            return Err("Code Mode destructuring needs a name.".into());
        }
        Ok(names)
    }

    fn bump(&mut self) -> Result<(), String> {
        self.stmts += 1;
        if self.stmts > MAX_STMTS {
            Err("Code Mode script has too many statements.".into())
        } else {
            Ok(())
        }
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

    fn skip_param_type(&mut self) {
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
                Token::Comma | Token::RParen if angle == 0 && paren == 0 && brace == 0 && bracket == 0 => return,
                Token::Lt => angle += 1,
                Token::Gt => angle -= 1,
                Token::LParen => paren += 1,
                Token::RParen => {
                    if paren == 0 {
                        return;
                    }
                    paren -= 1;
                }
                Token::LBrace => brace += 1,
                Token::RBrace => brace -= 1,
                Token::LBracket => bracket += 1,
                Token::RBracket => bracket -= 1,
                _ => {}
            }
            self.i += 1;
        }
    }

    fn parse_expr(&mut self) -> Result<Expr, String> {
        self.parse_arrow()
    }

    fn parse_arrow(&mut self) -> Result<Expr, String> {
        if let Token::Ident(name) = self.peek() {
            if name == "async" && self.looks_like_arrow_from(1) {
                self.i += 1;
            }
        }
        if !self.looks_like_arrow_from(0) {
            return self.parse_ternary();
        }
        let mut params = Vec::new();
        if let Token::Ident(_) = self.peek() {
            params.push(self.expect_ident()?);
        } else {
            self.expect(Token::LParen, "missing )")?;
            while !self.eof() && !matches!(self.peek(), Token::RParen) {
                if matches!(self.peek(), Token::Dot) {
                    return Err("Code Mode arrow parameters cannot use rest.".into());
                }
                params.push(self.expect_ident()?);
                if matches!(self.peek(), Token::Eq) {
                    return Err("Code Mode arrow parameters cannot have defaults.".into());
                }
                if matches!(self.peek(), Token::Colon) {
                    self.skip_param_type();
                }
                if matches!(self.peek(), Token::Comma) {
                    self.i += 1;
                    continue;
                }
                break;
            }
            self.expect(Token::RParen, "missing )")?;
        }
        if !matches!(self.peek(), Token::Arrow) {
            return Err("Code Mode expected =>.".into());
        }
        self.i += 1;
        let body = if matches!(self.peek(), Token::LBrace) {
            self.i += 1;
            if !matches!(self.peek(), Token::Return) {
                return Err("Code Mode arrow blocks may only return a value.".into());
            }
            self.i += 1;
            let expr = if self.eof() || matches!(self.peek(), Token::Semi | Token::RBrace) {
                Expr::Null
            } else {
                self.parse_expr()?
            };
            self.optional_semi();
            if !matches!(self.peek(), Token::RBrace) {
                return Err("Code Mode arrow blocks may only return a value.".into());
            }
            self.i += 1;
            ArrowBody::Return(Box::new(expr))
        } else {
            ArrowBody::Expr(Box::new(self.parse_arrow()?))
        };
        Ok(Expr::Arrow { params, body })
    }

    fn looks_like_arrow_from(&self, offset: usize) -> bool {
        match self.peek_at(offset) {
            Token::Ident(_) => matches!(self.peek_at(offset + 1), Token::Arrow),
            Token::LParen => {
                let mut depth = 0i32;
                let mut i = self.i + offset;
                while i < self.tokens.len() {
                    match &self.tokens[i] {
                        Token::LParen => depth += 1,
                        Token::RParen => {
                            depth -= 1;
                            if depth == 0 {
                                return matches!(self.tokens.get(i + 1), Some(Token::Arrow));
                            }
                        }
                        Token::Eof => return false,
                        _ => {}
                    }
                    i += 1;
                    if depth <= 0 {
                        break;
                    }
                }
                false
            }
            _ => false,
        }
    }

    fn parse_ternary(&mut self) -> Result<Expr, String> {
        let cond = self.parse_nullish()?;
        if !matches!(self.peek(), Token::Question) {
            return Ok(cond);
        }
        self.i += 1;
        let yes = self.parse_arrow()?;
        if !matches!(self.peek(), Token::Colon) {
            return Err("Code Mode ternary needs a colon.".into());
        }
        self.i += 1;
        let no = self.parse_ternary()?;
        Ok(Expr::Ternary(Box::new(cond), Box::new(yes), Box::new(no)))
    }

    fn parse_nullish(&mut self) -> Result<Expr, String> {
        let mut left = self.parse_or()?;
        while matches!(self.peek(), Token::Nullish) {
            self.i += 1;
            let right = self.parse_or()?;
            left = Expr::Nullish(Box::new(left), Box::new(right));
        }
        Ok(left)
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
        let mut left = self.parse_rel()?;
        loop {
            match self.peek() {
                Token::EqEq => {
                    self.i += 1;
                    let right = self.parse_rel()?;
                    left = Expr::Eq(Box::new(left), Box::new(right));
                }
                Token::NotEq => {
                    self.i += 1;
                    let right = self.parse_rel()?;
                    left = Expr::Ne(Box::new(left), Box::new(right));
                }
                _ => break,
            }
        }
        Ok(left)
    }

    fn parse_rel(&mut self) -> Result<Expr, String> {
        let mut left = self.parse_add()?;
        loop {
            let op = match self.peek() {
                Token::Lt => "lt",
                Token::Gt => "gt",
                Token::Le => "le",
                Token::Ge => "ge",
                _ => break,
            };
            self.i += 1;
            let right = self.parse_add()?;
            left = match op {
                "lt" => Expr::Lt(Box::new(left), Box::new(right)),
                "gt" => Expr::Gt(Box::new(left), Box::new(right)),
                "le" => Expr::Le(Box::new(left), Box::new(right)),
                _ => Expr::Ge(Box::new(left), Box::new(right)),
            };
        }
        Ok(left)
    }

    fn parse_add(&mut self) -> Result<Expr, String> {
        let mut left = self.parse_mul()?;
        loop {
            match self.peek() {
                Token::Plus => {
                    self.i += 1;
                    let right = self.parse_mul()?;
                    left = Expr::Add(Box::new(left), Box::new(right));
                }
                Token::Minus => {
                    self.i += 1;
                    let right = self.parse_mul()?;
                    left = Expr::Sub(Box::new(left), Box::new(right));
                }
                _ => break,
            }
        }
        Ok(left)
    }

    fn parse_mul(&mut self) -> Result<Expr, String> {
        let mut left = self.parse_unary()?;
        loop {
            match self.peek() {
                Token::Star => {
                    self.i += 1;
                    let right = self.parse_unary()?;
                    left = Expr::Mul(Box::new(left), Box::new(right));
                }
                Token::Slash => {
                    self.i += 1;
                    let right = self.parse_unary()?;
                    left = Expr::Div(Box::new(left), Box::new(right));
                }
                Token::Percent => {
                    self.i += 1;
                    let right = self.parse_unary()?;
                    left = Expr::Mod(Box::new(left), Box::new(right));
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
        if matches!(self.peek(), Token::Not) {
            self.i += 1;
            return Ok(Expr::Not(Box::new(self.parse_unary()?)));
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
                Token::OptionalDot => {
                    self.i += 1;
                    if matches!(self.peek(), Token::LParen) {
                        return Err("Code Mode does not run optional calls.".into());
                    }
                    if matches!(self.peek(), Token::LBracket) {
                        self.i += 1;
                        let index = self.parse_expr()?;
                        self.expect(Token::RBracket, "missing ]")?;
                        expr = Expr::OptionalIndex(Box::new(expr), Box::new(index));
                    } else {
                        let name = self.expect_ident()?;
                        if matches!(self.peek(), Token::LParen) {
                            if !is_method(&name) {
                                return Err("Code Mode does not run optional calls.".into());
                            }
                            self.i += 1;
                            let args = self.parse_args()?;
                            expr = Expr::Call(Box::new(Expr::OptionalMember(Box::new(expr), name)), args);
                        } else {
                            expr = Expr::OptionalMember(Box::new(expr), name);
                        }
                    }
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
            Token::Template(pieces) => {
                let pieces = pieces.clone();
                self.i += 1;
                self.parse_template(pieces)
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
                    let (key, quoted) = match self.peek() {
                        Token::Ident(name) => {
                            let key = name.clone();
                            self.i += 1;
                            (key, false)
                        }
                        Token::String(name) => {
                            let key = name.clone();
                            self.i += 1;
                            (key, true)
                        }
                        _ => return Err("Code Mode object keys must be names or strings.".into()),
                    };
                    reject_prop(&key)?;
                    let value = if !quoted && matches!(self.peek(), Token::Comma | Token::RBrace) {
                        Expr::Ident(key.clone())
                    } else {
                        self.expect(Token::Colon, "object field needs a colon")?;
                        self.parse_expr()?
                    };
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

    fn parse_template(&mut self, pieces: Vec<TemplatePiece>) -> Result<Expr, String> {
        let mut segs = Vec::new();
        for piece in pieces {
            match piece {
                TemplatePiece::Text(text) => segs.push(TSeg::Text(text)),
                TemplatePiece::Expr(src) => {
                    let src = src.trim();
                    if src.is_empty() {
                        return Err("Code Mode template interpolation is empty.".into());
                    }
                    let tokens = tokenize(src)?;
                    let mut sub = Parser { tokens, i: 0, stmts: 0 };
                    let expr = sub.parse_expr()?;
                    if !sub.eof() {
                        return Err("Code Mode template interpolation has extra tokens.".into());
                    }
                    segs.push(TSeg::Expr(expr));
                }
            }
        }
        Ok(Expr::Template(segs))
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
        self.peek_at(0)
    }

    fn peek_at(&self, offset: usize) -> &Token {
        self.tokens.get(self.i + offset).unwrap_or(&Token::Eof)
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

struct Frame {
    vals: Map<String, Value>,
    consts: HashSet<String>,
}

struct Env {
    frames: Vec<Frame>,
}

impl Env {
    fn new() -> Self {
        Self { frames: vec![Frame { vals: Map::new(), consts: HashSet::new() }] }
    }

    fn push(&mut self) {
        self.frames.push(Frame { vals: Map::new(), consts: HashSet::new() });
    }

    fn pop(&mut self) {
        if self.frames.len() > 1 {
            self.frames.pop();
        }
    }

    fn get(&self, name: &str) -> Option<Value> {
        for frame in self.frames.iter().rev() {
            if let Some(value) = frame.vals.get(name) {
                return Some(value.clone());
            }
        }
        None
    }

    fn decl(&mut self, name: String, value: Value, is_const: bool) -> Result<(), String> {
        let frame = self.frames.last_mut().expect("env frame");
        if frame.vals.contains_key(&name) {
            return Err(format!("`{name}` is already declared in this block."));
        }
        if is_const {
            frame.consts.insert(name.clone());
        }
        frame.vals.insert(name, value);
        Ok(())
    }

    fn assign(&mut self, name: &str, value: Value) -> Result<(), String> {
        for frame in self.frames.iter_mut().rev() {
            if frame.vals.contains_key(name) {
                if frame.consts.contains(name) {
                    return Err(format!("Code Mode cannot assign to const `{name}`."));
                }
                frame.vals.insert(name.to_string(), value);
                return Ok(());
            }
        }
        Err(format!("`{name}` is not defined in this Code Mode script."))
    }
}

fn with_frame<T>(env: &mut Env, body: impl FnOnce(&mut Env) -> Result<T, String>) -> Result<T, String> {
    env.push();
    let result = body(env);
    env.pop();
    result
}

struct Budget {
    callbacks: u32,
    loops: u32,
}

enum Flow {
    Next(Value),
    Return(Value),
}

fn eval_stmt(
    stmt: &Stmt,
    env: &mut Env,
    dispatch: &mut dyn FnMut(&str, &Value) -> Result<Value, String>,
    servers: &[(String, String)],
    budget: &mut Budget,
    depth: u32,
) -> Result<Flow, String> {
    if depth > MAX_DEPTH {
        return Err("Code Mode expression is too nested.".into());
    }
    match stmt {
        Stmt::Empty => Ok(Flow::Next(Value::Null)),
        Stmt::Decl { name, expr, is_const } => {
            let value = eval_expr(expr, env, dispatch, servers, budget, depth + 1)?;
            env.decl(name.clone(), value, *is_const)?;
            Ok(Flow::Next(Value::Null))
        }
        Stmt::DeclObject { fields, expr, is_const } => {
            let value = eval_expr(expr, env, dispatch, servers, budget, depth + 1)?;
            if !value.is_object() {
                return Err("Code Mode object destructuring needs an object.".into());
            }
            for (key, local) in fields {
                env.decl(local.clone(), json_member(&value, key)?, *is_const)?;
            }
            Ok(Flow::Next(Value::Null))
        }
        Stmt::DeclArray { names, expr, is_const } => {
            let value = eval_expr(expr, env, dispatch, servers, budget, depth + 1)?;
            if !value.is_array() {
                return Err("Code Mode array destructuring needs an array.".into());
            }
            for (index, name) in names.iter().enumerate() {
                env.decl(name.clone(), json_index(&value, &json!(index as f64))?, *is_const)?;
            }
            Ok(Flow::Next(Value::Null))
        }
        Stmt::Assign(name, expr) => {
            let value = eval_expr(expr, env, dispatch, servers, budget, depth + 1)?;
            env.assign(name, value.clone())?;
            Ok(Flow::Next(value))
        }
        Stmt::Expr(expr) => Ok(Flow::Next(eval_expr(expr, env, dispatch, servers, budget, depth + 1)?)),
        Stmt::Return(expr) => Ok(Flow::Return(eval_expr(expr, env, dispatch, servers, budget, depth + 1)?)),
        Stmt::Block(stmts) => with_frame(env, |env| {
            let mut last = Value::Null;
            for stmt in stmts {
                match eval_stmt(stmt, env, dispatch, servers, budget, depth + 1)? {
                    Flow::Next(value) => last = value,
                    Flow::Return(value) => return Ok(Flow::Return(value)),
                }
            }
            Ok(Flow::Next(last))
        }),
        Stmt::If(cond, then_stmt, else_stmt) => {
            let cond = eval_expr(cond, env, dispatch, servers, budget, depth + 1)?;
            if truthy(&cond) {
                eval_stmt(then_stmt, env, dispatch, servers, budget, depth + 1)
            } else if let Some(else_stmt) = else_stmt {
                eval_stmt(else_stmt, env, dispatch, servers, budget, depth + 1)
            } else {
                Ok(Flow::Next(Value::Null))
            }
        }
        Stmt::ForOf { name, is_const, iter, body } => {
            let value = eval_expr(iter, env, dispatch, servers, budget, depth + 1)?;
            let items = value.as_array().cloned().ok_or_else(|| "Code Mode for-of needs an array.".to_string())?;
            let count = u32::try_from(items.len()).unwrap_or(u32::MAX);
            if count > MAX_LOOP || budget.loops.saturating_add(count) > MAX_LOOP {
                return Err(format!("Code Mode for-of stopped at {MAX_LOOP} items."));
            }
            budget.loops += count;
            let mut last = Value::Null;
            for item in items {
                let flow = with_frame(env, |env| {
                    env.decl(name.clone(), item, *is_const)?;
                    eval_stmt(body, env, dispatch, servers, budget, depth + 1)
                })?;
                match flow {
                    Flow::Next(value) => last = value,
                    Flow::Return(value) => return Ok(Flow::Return(value)),
                }
            }
            Ok(Flow::Next(last))
        }
    }
}

enum Runtime {
    Json(Value),
    Ronic(Vec<String>),
}

fn eval_expr(
    expr: &Expr,
    env: &mut Env,
    dispatch: &mut dyn FnMut(&str, &Value) -> Result<Value, String>,
    servers: &[(String, String)],
    budget: &mut Budget,
    depth: u32,
) -> Result<Value, String> {
    if depth > MAX_DEPTH {
        return Err("Code Mode expression is too nested.".into());
    }
    match eval_runtime(expr, env, dispatch, servers, budget, depth)? {
        Runtime::Json(value) => Ok(value),
        Runtime::Ronic(path) => Err(format!("`{}` is a binding. Call it as a function.", path.join("."))),
    }
}

fn eval_runtime(
    expr: &Expr,
    env: &mut Env,
    dispatch: &mut dyn FnMut(&str, &Value) -> Result<Value, String>,
    servers: &[(String, String)],
    budget: &mut Budget,
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
        Expr::Template(segs) => {
            let mut out = String::new();
            for seg in segs {
                match seg {
                    TSeg::Text(text) => out.push_str(text),
                    TSeg::Expr(inner) => {
                        let value = eval_expr(inner, env, dispatch, servers, budget, depth + 1)?;
                        out.push_str(&display(&value));
                    }
                }
            }
            Ok(Runtime::Json(Value::String(out)))
        }
        Expr::Ident(name) => {
            if name == "ronic" {
                return Ok(Runtime::Ronic(vec!["ronic".into()]));
            }
            if FORBIDDEN.contains(&name.as_str()) {
                return Err(format!("Code Mode does not expose `{name}`."));
            }
            env.get(name).map(Runtime::Json).ok_or_else(|| format!("`{name}` is not defined in this Code Mode script."))
        }
        Expr::Array(items) => {
            let mut out = Vec::new();
            for item in items {
                out.push(eval_expr(item, env, dispatch, servers, budget, depth + 1)?);
            }
            Ok(Runtime::Json(Value::Array(out)))
        }
        Expr::Object(fields) => {
            let mut out = Map::new();
            for (key, value) in fields {
                reject_prop(key)?;
                out.insert(key.clone(), eval_expr(value, env, dispatch, servers, budget, depth + 1)?);
            }
            Ok(Runtime::Json(Value::Object(out)))
        }
        Expr::Member(base, name) => match eval_runtime(base, env, dispatch, servers, budget, depth + 1)? {
            Runtime::Ronic(mut path) => {
                reject_prop(name)?;
                path.push(name.clone());
                Ok(Runtime::Ronic(path))
            }
            Runtime::Json(value) => Ok(Runtime::Json(json_member(&value, name)?)),
        },
        Expr::OptionalMember(base, name) => match eval_runtime(base, env, dispatch, servers, budget, depth + 1)? {
            Runtime::Ronic(mut path) => {
                reject_prop(name)?;
                path.push(name.clone());
                Ok(Runtime::Ronic(path))
            }
            Runtime::Json(value) => {
                if value.is_null() {
                    return Ok(Runtime::Json(Value::Null));
                }
                Ok(Runtime::Json(json_member(&value, name)?))
            }
        },
        Expr::Index(base, index) => {
            let index = eval_expr(index, env, dispatch, servers, budget, depth + 1)?;
            match eval_runtime(base, env, dispatch, servers, budget, depth + 1)? {
                Runtime::Ronic(_) => Err("Code Mode ronic paths use dot names, not brackets.".into()),
                Runtime::Json(value) => Ok(Runtime::Json(json_index(&value, &index)?)),
            }
        }
        Expr::OptionalIndex(base, index) => match eval_runtime(base, env, dispatch, servers, budget, depth + 1)? {
            Runtime::Ronic(_) => Err("Code Mode ronic paths use dot names, not brackets.".into()),
            Runtime::Json(value) => {
                if value.is_null() {
                    return Ok(Runtime::Json(Value::Null));
                }
                let index = eval_expr(index, env, dispatch, servers, budget, depth + 1)?;
                Ok(Runtime::Json(json_index(&value, &index)?))
            }
        },
        Expr::Call(callee, args) => {
            if let Some(value) = object_builtin(callee, args, env, dispatch, servers, budget, depth)? {
                return Ok(Runtime::Json(value));
            }
            if let Some(value) = method_call(callee, args, env, dispatch, servers, budget, depth)? {
                return Ok(Runtime::Json(value));
            }
            let mut values = Vec::new();
            for arg in args {
                values.push(eval_expr(arg, env, dispatch, servers, budget, depth + 1)?);
            }
            match eval_runtime(callee, env, dispatch, servers, budget, depth + 1)? {
                Runtime::Ronic(path) => Ok(Runtime::Json(ronic_call(&path, &values, dispatch, servers)?)),
                Runtime::Json(value) if value.is_null() => Err("Code Mode cannot call null.".into()),
                Runtime::Json(_) => Err("Code Mode only calls ronic.* functions.".into()),
            }
        }
        Expr::Await(inner) => eval_runtime(inner, env, dispatch, servers, budget, depth + 1),
        Expr::Not(inner) => {
            let value = eval_expr(inner, env, dispatch, servers, budget, depth + 1)?;
            Ok(Runtime::Json(Value::Bool(!truthy(&value))))
        }
        Expr::Or(left, right) => {
            let left = eval_expr(left, env, dispatch, servers, budget, depth + 1)?;
            if truthy(&left) {
                Ok(Runtime::Json(left))
            } else {
                Ok(Runtime::Json(eval_expr(right, env, dispatch, servers, budget, depth + 1)?))
            }
        }
        Expr::And(left, right) => {
            let left = eval_expr(left, env, dispatch, servers, budget, depth + 1)?;
            if !truthy(&left) {
                Ok(Runtime::Json(left))
            } else {
                Ok(Runtime::Json(eval_expr(right, env, dispatch, servers, budget, depth + 1)?))
            }
        }
        Expr::Nullish(left, right) => {
            let left = eval_expr(left, env, dispatch, servers, budget, depth + 1)?;
            if left.is_null() {
                eval_runtime(right, env, dispatch, servers, budget, depth + 1)
            } else {
                Ok(Runtime::Json(left))
            }
        }
        Expr::Eq(left, right) => Ok(Runtime::Json(Value::Bool(eval_expr(left, env, dispatch, servers, budget, depth + 1)? == eval_expr(right, env, dispatch, servers, budget, depth + 1)?))),
        Expr::Ne(left, right) => Ok(Runtime::Json(Value::Bool(eval_expr(left, env, dispatch, servers, budget, depth + 1)? != eval_expr(right, env, dispatch, servers, budget, depth + 1)?))),
        Expr::Lt(left, right) => Ok(Runtime::Json(cmp_numbers(&eval_expr(left, env, dispatch, servers, budget, depth + 1)?, &eval_expr(right, env, dispatch, servers, budget, depth + 1)?, |a, b| a < b)?)),
        Expr::Gt(left, right) => Ok(Runtime::Json(cmp_numbers(&eval_expr(left, env, dispatch, servers, budget, depth + 1)?, &eval_expr(right, env, dispatch, servers, budget, depth + 1)?, |a, b| a > b)?)),
        Expr::Le(left, right) => Ok(Runtime::Json(cmp_numbers(&eval_expr(left, env, dispatch, servers, budget, depth + 1)?, &eval_expr(right, env, dispatch, servers, budget, depth + 1)?, |a, b| a <= b)?)),
        Expr::Ge(left, right) => Ok(Runtime::Json(cmp_numbers(&eval_expr(left, env, dispatch, servers, budget, depth + 1)?, &eval_expr(right, env, dispatch, servers, budget, depth + 1)?, |a, b| a >= b)?)),
        Expr::Add(left, right) => {
            let left = eval_expr(left, env, dispatch, servers, budget, depth + 1)?;
            let right = eval_expr(right, env, dispatch, servers, budget, depth + 1)?;
            Ok(Runtime::Json(add_values(&left, &right)?))
        }
        Expr::Sub(left, right) => Ok(Runtime::Json(arith("subtraction", &eval_expr(left, env, dispatch, servers, budget, depth + 1)?, &eval_expr(right, env, dispatch, servers, budget, depth + 1)?)?)),
        Expr::Mul(left, right) => Ok(Runtime::Json(arith("multiplication", &eval_expr(left, env, dispatch, servers, budget, depth + 1)?, &eval_expr(right, env, dispatch, servers, budget, depth + 1)?)?)),
        Expr::Div(left, right) => Ok(Runtime::Json(arith("division", &eval_expr(left, env, dispatch, servers, budget, depth + 1)?, &eval_expr(right, env, dispatch, servers, budget, depth + 1)?)?)),
        Expr::Mod(left, right) => Ok(Runtime::Json(arith("remainder", &eval_expr(left, env, dispatch, servers, budget, depth + 1)?, &eval_expr(right, env, dispatch, servers, budget, depth + 1)?)?)),
        Expr::Ternary(cond, yes, no) => {
            let cond = eval_expr(cond, env, dispatch, servers, budget, depth + 1)?;
            if truthy(&cond) {
                eval_runtime(yes, env, dispatch, servers, budget, depth + 1)
            } else {
                eval_runtime(no, env, dispatch, servers, budget, depth + 1)
            }
        }
        Expr::Arrow { .. } => Err("Code Mode arrow functions only run as a callback to filter, map, find, findIndex, some, every, or forEach.".into()),
    }
}

fn method_call(
    callee: &Expr,
    args: &[Expr],
    env: &mut Env,
    dispatch: &mut dyn FnMut(&str, &Value) -> Result<Value, String>,
    servers: &[(String, String)],
    budget: &mut Budget,
    depth: u32,
) -> Result<Option<Value>, String> {
    let (base, name, optional) = match callee {
        Expr::Member(base, name) => (base.as_ref(), name.as_str(), false),
        Expr::OptionalMember(base, name) => (base.as_ref(), name.as_str(), true),
        _ => return Ok(None),
    };
    if !is_method(name) {
        return Ok(None);
    }
    if name == "push" {
        return Ok(Some(push_let(base, args, optional, env, dispatch, servers, budget, depth)?));
    }
    let receiver = match eval_runtime(base, env, dispatch, servers, budget, depth + 1)? {
        Runtime::Ronic(_) => return Ok(None),
        Runtime::Json(value) => value,
    };
    if optional && receiver.is_null() {
        return Ok(Some(Value::Null));
    }
    apply_method(&receiver, name, args, env, dispatch, servers, budget, depth + 1).map(Some)
}

fn is_method(name: &str) -> bool {
    matches!(
        name,
        "filter"
            | "map"
            | "find"
            | "findIndex"
            | "some"
            | "every"
            | "forEach"
            | "slice"
            | "includes"
            | "indexOf"
            | "join"
            | "concat"
            | "push"
            | "split"
            | "startsWith"
            | "endsWith"
            | "toLowerCase"
            | "toUpperCase"
            | "trim"
    )
}

fn object_builtin(
    callee: &Expr,
    args: &[Expr],
    env: &mut Env,
    dispatch: &mut dyn FnMut(&str, &Value) -> Result<Value, String>,
    servers: &[(String, String)],
    budget: &mut Budget,
    depth: u32,
) -> Result<Option<Value>, String> {
    let Expr::Member(base, name) = callee else {
        return Ok(None);
    };
    if !matches!(name.as_str(), "keys" | "values" | "entries") {
        return Ok(None);
    }
    let Expr::Ident(root) = base.as_ref() else {
        return Ok(None);
    };
    if root != "Object" {
        return Ok(None);
    }
    if args.len() != 1 {
        return Err(format!("Code Mode Object.{name} takes one object."));
    }
    let value = eval_expr(&args[0], env, dispatch, servers, budget, depth + 1)?;
    object_fields(&value, name).map(Some)
}

fn object_fields(value: &Value, name: &str) -> Result<Value, String> {
    let Some(map) = value.as_object() else {
        return Err(format!("Code Mode Object.{name} needs an object."));
    };
    if map.len() > MAX_LOOP as usize {
        return Err(format!("Code Mode Object.{name} stopped at {MAX_LOOP} fields."));
    }
    let mut out = Vec::new();
    for (key, item) in map {
        if reject_prop(key).is_err() {
            continue;
        }
        match name {
            "keys" => out.push(Value::String(key.clone())),
            "values" => out.push(item.clone()),
            _ => out.push(Value::Array(vec![Value::String(key.clone()), item.clone()])),
        }
    }
    Ok(Value::Array(out))
}

fn apply_method(
    receiver: &Value,
    name: &str,
    args: &[Expr],
    env: &mut Env,
    dispatch: &mut dyn FnMut(&str, &Value) -> Result<Value, String>,
    servers: &[(String, String)],
    budget: &mut Budget,
    depth: u32,
) -> Result<Value, String> {
    if let Some(items) = receiver.as_array() {
        return array_method(items, name, args, env, dispatch, servers, budget, depth);
    }
    if let Some(text) = receiver.as_str() {
        return string_method(text, name, args, env, dispatch, servers, budget, depth);
    }
    Err(format!("Code Mode cannot call `{name}` on this value."))
}

fn array_method(
    items: &[Value],
    name: &str,
    args: &[Expr],
    env: &mut Env,
    dispatch: &mut dyn FnMut(&str, &Value) -> Result<Value, String>,
    servers: &[(String, String)],
    budget: &mut Budget,
    depth: u32,
) -> Result<Value, String> {
    match name {
        "filter" | "map" | "find" | "findIndex" | "some" | "every" | "forEach" => array_callback(items, name, args, env, dispatch, servers, budget, depth),
        "indexOf" => {
            if args.len() != 1 {
                return Err("Code Mode indexOf takes one value.".into());
            }
            let needle = eval_expr(&args[0], env, dispatch, servers, budget, depth + 1)?;
            let pos = items.iter().position(|item| item == &needle);
            Ok(match pos {
                Some(index) => json!(index as f64),
                None => json!(-1.0),
            })
        },
        "slice" => array_slice(items, args, env, dispatch, servers, budget, depth),
        "concat" => array_concat(items, args, env, dispatch, servers, budget, depth),
        "includes" => {
            if args.len() != 1 {
                return Err("Code Mode includes takes one value.".into());
            }
            let needle = eval_expr(&args[0], env, dispatch, servers, budget, depth + 1)?;
            Ok(Value::Bool(items.iter().any(|item| item == &needle)))
        }
        "join" => array_join(items, args, env, dispatch, servers, budget, depth),
        _ => Err(format!("Code Mode cannot call `{name}` on an array.")),
    }
}

fn array_callback(
    items: &[Value],
    name: &str,
    args: &[Expr],
    env: &mut Env,
    dispatch: &mut dyn FnMut(&str, &Value) -> Result<Value, String>,
    servers: &[(String, String)],
    budget: &mut Budget,
    depth: u32,
) -> Result<Value, String> {
    let pred = match args {
        [expr @ Expr::Arrow { .. }] => expr,
        _ => return Err(format!("Code Mode `{name}` takes one arrow callback.")),
    };
    let mut out = Vec::new();
    for (index, item) in items.iter().enumerate() {
        let verdict = call_arrow(pred, item, index, env, dispatch, servers, budget, depth)?;
        match name {
            "filter" if truthy(&verdict) => out.push(item.clone()),
            "map" => out.push(verdict),
            "find" if truthy(&verdict) => return Ok(item.clone()),
            "findIndex" if truthy(&verdict) => return Ok(json!(index as f64)),
            "some" if truthy(&verdict) => return Ok(Value::Bool(true)),
            "every" if !truthy(&verdict) => return Ok(Value::Bool(false)),
            _ => {}
        }
    }
    match name {
        "find" => Ok(Value::Null),
        "findIndex" => Ok(json!(-1.0)),
        "some" => Ok(Value::Bool(false)),
        "every" => Ok(Value::Bool(true)),
        "forEach" => Ok(Value::Null),
        _ => Ok(Value::Array(out)),
    }
}

fn call_arrow(
    arrow: &Expr,
    element: &Value,
    index: usize,
    env: &mut Env,
    dispatch: &mut dyn FnMut(&str, &Value) -> Result<Value, String>,
    servers: &[(String, String)],
    budget: &mut Budget,
    depth: u32,
) -> Result<Value, String> {
    budget.callbacks += 1;
    if budget.callbacks > MAX_CALLBACKS {
        return Err(format!("Code Mode stopped after {MAX_CALLBACKS} callback calls."));
    }
    let Expr::Arrow { params, body } = arrow else {
        return Err("Code Mode expected an arrow callback.".into());
    };
    with_frame(env, |env| {
        if let Some(name) = params.get(0) {
            env.decl(name.clone(), element.clone(), true)?;
        }
        if let Some(name) = params.get(1) {
            env.decl(name.clone(), json!(index as f64), true)?;
        }
        for name in params.iter().skip(2) {
            env.decl(name.clone(), Value::Null, true)?;
        }
        let expr = match body {
            ArrowBody::Expr(expr) | ArrowBody::Return(expr) => expr.as_ref(),
        };
        eval_expr(expr, env, dispatch, servers, budget, depth + 1)
    })
}

fn array_slice(
    items: &[Value],
    args: &[Expr],
    env: &mut Env,
    dispatch: &mut dyn FnMut(&str, &Value) -> Result<Value, String>,
    servers: &[(String, String)],
    budget: &mut Budget,
    depth: u32,
) -> Result<Value, String> {
    if args.len() > 2 {
        return Err("Code Mode slice takes at most two indexes.".into());
    }
    let start = if args.is_empty() { 0.0 } else { eval_number(&args[0], env, dispatch, servers, budget, depth)? };
    let end = if args.len() < 2 { items.len() as f64 } else { eval_number(&args[1], env, dispatch, servers, budget, depth)? };
    let start = js_bound(start, items.len())?;
    let end = js_bound(end, items.len())?;
    if start >= end {
        return Ok(Value::Array(Vec::new()));
    }
    Ok(Value::Array(items[start..end].to_vec()))
}

fn push_let(
    base: &Expr,
    args: &[Expr],
    optional: bool,
    env: &mut Env,
    dispatch: &mut dyn FnMut(&str, &Value) -> Result<Value, String>,
    servers: &[(String, String)],
    budget: &mut Budget,
    depth: u32,
) -> Result<Value, String> {
    let Expr::Ident(name) = base else {
        return Err("Code Mode push only updates a let array.".into());
    };
    let current = env.get(name).ok_or_else(|| format!("`{name}` is not defined in this Code Mode script."))?;
    if optional && current.is_null() {
        return Ok(Value::Null);
    }
    let Some(items) = current.as_array() else {
        return Err("Code Mode push needs an array.".into());
    };
    if args.len() != 1 {
        return Err("Code Mode push takes one value.".into());
    }
    if items.len() >= MAX_LOOP as usize {
        return Err(format!("Code Mode push stopped at {MAX_LOOP} items."));
    }
    let mut next = items.clone();
    next.push(eval_expr(&args[0], env, dispatch, servers, budget, depth + 1)?);
    let len = json!(next.len() as f64);
    env.assign(name, Value::Array(next))?;
    Ok(len)
}

fn array_concat(
    items: &[Value],
    args: &[Expr],
    env: &mut Env,
    dispatch: &mut dyn FnMut(&str, &Value) -> Result<Value, String>,
    servers: &[(String, String)],
    budget: &mut Budget,
    depth: u32,
) -> Result<Value, String> {
    if args.len() > 8 {
        return Err("Code Mode concat takes at most 8 values.".into());
    }
    let mut out = items.to_vec();
    for arg in args {
        let value = eval_expr(arg, env, dispatch, servers, budget, depth + 1)?;
        if let Some(extra) = value.as_array() {
            out.extend(extra.iter().cloned());
        } else {
            out.push(value);
        }
        if out.len() > MAX_LOOP as usize {
            return Err(format!("Code Mode concat stopped at {MAX_LOOP} items."));
        }
    }
    Ok(Value::Array(out))
}

fn array_join(
    items: &[Value],
    args: &[Expr],
    env: &mut Env,
    dispatch: &mut dyn FnMut(&str, &Value) -> Result<Value, String>,
    servers: &[(String, String)],
    budget: &mut Budget,
    depth: u32,
) -> Result<Value, String> {
    if args.len() > 1 {
        return Err("Code Mode join takes at most one separator.".into());
    }
    let sep = if args.is_empty() {
        ",".to_string()
    } else {
        display(&eval_expr(&args[0], env, dispatch, servers, budget, depth + 1)?)
    };
    let text = items.iter().map(display).collect::<Vec<_>>().join(&sep);
    Ok(Value::String(text))
}

fn string_method(
    text: &str,
    name: &str,
    args: &[Expr],
    env: &mut Env,
    dispatch: &mut dyn FnMut(&str, &Value) -> Result<Value, String>,
    servers: &[(String, String)],
    budget: &mut Budget,
    depth: u32,
) -> Result<Value, String> {
    match name {
        "toLowerCase" | "toUpperCase" | "trim" => {
            if !args.is_empty() {
                return Err(format!("Code Mode `{name}` does not take arguments."));
            }
            let out = match name {
                "toLowerCase" => text.to_lowercase(),
                "toUpperCase" => text.to_uppercase(),
                _ => text.trim().to_string(),
            };
            Ok(Value::String(out))
        }
        "indexOf" => {
            if args.len() != 1 {
                return Err("Code Mode indexOf takes one string.".into());
            }
            let needle = display(&eval_expr(&args[0], env, dispatch, servers, budget, depth + 1)?);
            let pos = text.find(&needle).map(|byte| text[..byte].chars().count());
            Ok(match pos {
                Some(index) => json!(index as f64),
                None => json!(-1.0),
            })
        }
        "includes" | "startsWith" | "endsWith" => {
            if args.len() != 1 {
                return Err(format!("Code Mode `{name}` takes one string."));
            }
            let needle = display(&eval_expr(&args[0], env, dispatch, servers, budget, depth + 1)?);
            let ok = match name {
                "includes" => text.contains(&needle),
                "startsWith" => text.starts_with(&needle),
                _ => text.ends_with(&needle),
            };
            Ok(Value::Bool(ok))
        }
        "slice" => {
            if args.len() > 2 {
                return Err("Code Mode slice takes at most two indexes.".into());
            }
            let chars: Vec<char> = text.chars().collect();
            let start = if args.is_empty() { 0.0 } else { eval_number(&args[0], env, dispatch, servers, budget, depth)? };
            let end = if args.len() < 2 { chars.len() as f64 } else { eval_number(&args[1], env, dispatch, servers, budget, depth)? };
            let start = js_bound(start, chars.len())?;
            let end = js_bound(end, chars.len())?;
            if start >= end {
                return Ok(Value::String(String::new()));
            }
            Ok(Value::String(chars[start..end].iter().collect()))
        }
        "split" => {
            if args.len() != 1 {
                return Err("Code Mode split takes a separator.".into());
            }
            let sep = display(&eval_expr(&args[0], env, dispatch, servers, budget, depth + 1)?);
            let parts: Vec<Value> = if sep.is_empty() {
                text.chars().map(|c| Value::String(c.to_string())).collect()
            } else {
                text.split(&sep).map(|part| Value::String(part.to_string())).collect()
            };
            if parts.len() > MAX_SPLIT {
                return Err(format!("Code Mode split stopped at {MAX_SPLIT} parts."));
            }
            Ok(Value::Array(parts))
        }
        _ => Err(format!("Code Mode cannot call `{name}` on a string.")),
    }
}

fn eval_number(
    expr: &Expr,
    env: &mut Env,
    dispatch: &mut dyn FnMut(&str, &Value) -> Result<Value, String>,
    servers: &[(String, String)],
    budget: &mut Budget,
    depth: u32,
) -> Result<f64, String> {
    let value = eval_expr(expr, env, dispatch, servers, budget, depth + 1)?;
    as_f64(&value).ok_or_else(|| "Code Mode expected a number.".to_string())
}

fn js_bound(raw: f64, len: usize) -> Result<usize, String> {
    if !raw.is_finite() || raw.abs() > 1_000_000.0 {
        return Err("Code Mode index is out of range.".into());
    }
    let len_i = len as isize;
    let mut i = raw as isize;
    if raw < 0.0 {
        i += len_i;
    }
    if i < 0 {
        i = 0;
    }
    if i > len_i {
        i = len_i;
    }
    Ok(i as usize)
}

fn json_member(value: &Value, name: &str) -> Result<Value, String> {
    reject_prop(name)?;
    if name == "length" {
        return Ok(match value {
            Value::Array(items) => json!(items.len() as f64),
            Value::String(text) => json!(text.chars().count() as f64),
            other => other.get("length").cloned().unwrap_or(Value::Null),
        });
    }
    Ok(value.get(name).cloned().unwrap_or(Value::Null))
}

fn json_index(value: &Value, index: &Value) -> Result<Value, String> {
    if let Some(n) = as_f64(index) {
        if !n.is_finite() || n < 0.0 || n > 1_000_000.0 {
            return Ok(Value::Null);
        }
        let i = n as usize;
        return Ok(match value {
            Value::Array(items) => items.get(i).cloned().unwrap_or(Value::Null),
            Value::String(text) => text.chars().nth(i).map(|c| Value::String(c.to_string())).unwrap_or(Value::Null),
            _ => Value::Null,
        });
    }
    if let Some(key) = index.as_str() {
        return json_member(value, key);
    }
    Ok(Value::Null)
}

fn reject_prop(name: &str) -> Result<(), String> {
    if name == "__proto__" || name == "constructor" || name == "prototype" {
        return Err("Code Mode does not expose that property.".into());
    }
    Ok(())
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

fn cmp_numbers(left: &Value, right: &Value, op: impl Fn(f64, f64) -> bool) -> Result<Value, String> {
    let a = as_f64(left).ok_or_else(|| "Code Mode comparisons need numbers.".to_string())?;
    let b = as_f64(right).ok_or_else(|| "Code Mode comparisons need numbers.".to_string())?;
    Ok(Value::Bool(op(a, b)))
}

fn arith(op: &str, left: &Value, right: &Value) -> Result<Value, String> {
    let a = as_f64(left).ok_or_else(|| format!("Code Mode {op} needs numbers."))?;
    let b = as_f64(right).ok_or_else(|| format!("Code Mode {op} needs numbers."))?;
    if (op == "division" || op == "remainder") && b == 0.0 {
        return Err("Code Mode cannot divide by zero.".into());
    }
    let n = match op {
        "multiplication" => a * b,
        "division" => a / b,
        "remainder" => a % b,
        "subtraction" => a - b,
        _ => a + b,
    };
    if !n.is_finite() {
        return Err("Code Mode number result is not finite.".into());
    }
    Ok(json!(n))
}

fn add_values(left: &Value, right: &Value) -> Result<Value, String> {
    if let (Some(a), Some(b)) = (as_f64(left), as_f64(right)) {
        return arith("addition", &json!(a), &json!(b));
    }
    Ok(Value::String(format!("{}{}", display(left), display(right))))
}

fn display(value: &Value) -> String {
    match value {
        Value::Null => "null".into(),
        Value::Bool(v) => v.to_string(),
        Value::Number(n) => {
            if let Some(i) = n.as_i64() {
                i.to_string()
            } else if let Some(u) = n.as_u64() {
                u.to_string()
            } else if let Some(f) = n.as_f64() {
                if f.is_finite() && f.fract() == 0.0 && f.abs() < 1e15 {
                    format!("{}", f as i64)
                } else {
                    f.to_string()
                }
            } else {
                n.to_string()
            }
        }
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
        ["mem0", "curate"] => dispatch(
            "mem0.curate",
            &json!({
                "target": arg_string(args, 0),
                "action": arg_string(args, 1),
                "content": arg_string(args, 2),
                "oldText": arg_string(args, 3)
            }),
        ),
        ["mem0", "link"] => dispatch(
            "mem0.link",
            &json!({ "title": arg_string(args, 0), "target": arg_string(args, 1), "relation": arg_string(args, 2) }),
        ),
        ["mem0", "unlink"] => dispatch(
            "mem0.unlink",
            &json!({ "title": arg_string(args, 0), "target": arg_string(args, 1) }),
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
        ["apps", "web"] => dispatch("apps.web", &dock_args(args)),
        ["apps", "desktop"] => dispatch("apps.desktop", &dock_args(args)),
        ["computer", "somClick"] => dispatch("computer.somClick", &json!({ "markId": arg_number(args, 0) })),
        ["computer", "somType"] => dispatch("computer.somType", &json!({ "markId": arg_number(args, 0), "text": arg_string(args, 1) })),
        ["computer", "inspectNative"] => dispatch("computer.inspectNative", &json!({ "windowFilter": arg_string(args, 0) })),
        ["computer", "haltStatus"] => dispatch("computer.haltStatus", &json!({})),
        ["acp", "askPeer"] => dispatch("acp.askPeer", &json!({ "target": arg_string(args, 0), "prompt": arg_string(args, 1) })),
        _ => Err(format!("`{}` is not an Ronic Code Mode binding.", path.join("."))),
    }
}

fn dock_args(args: &[Value]) -> Value {
    match args.first() {
        Some(Value::Object(map)) => Value::Object(map.clone()),
        Some(_) => json!({
            "action": arg_string(args, 0),
            "app": arg_string(args, 1),
            "text": arg_string(args, 2),
        }),
        None => json!({}),
    }
}

fn arg_string(args: &[Value], index: usize) -> String {
    match args.get(index) {
        Some(Value::String(s)) => s.clone(),
        Some(Value::Null) | None => String::new(),
        Some(other) => other.to_string(),
    }
}

fn arg_number(args: &[Value], index: usize) -> f64 {
    args.get(index).and_then(as_f64).unwrap_or(0.0)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn run_calls(script: &str) -> Result<(Value, Vec<String>), String> {
        let mut calls = Vec::new();
        let value = eval(
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
        )?;
        Ok((value, calls))
    }

    fn run(script: &str) -> Result<Value, String> {
        run_calls(script).map(|(value, _)| value)
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
        assert_eq!(value["skillCount"].as_f64(), Some(1.0));
        assert_eq!(value["factCount"].as_f64(), Some(1.0));
        assert_eq!(value["first"]["slug"].as_str(), Some("demo"));
    }

    #[test]
    fn refuses_eval_and_process() {
        assert!(run("return eval('1')").is_err());
        assert!(run("return process.env").is_err());
        assert!(run("new Function('return 1')()").is_err());
        assert!(run("import fs from 'fs'").is_err());
        assert!(run("while (true) { return 1; }").unwrap_err().contains("while"));
    }

    #[test]
    fn unknown_ronic_path_fails() {
        let error = run("return await ronic.shell.exec('dir')").unwrap_err();
        assert!(error.contains("not an Ronic Code Mode binding"), "{error}");
    }

    #[test]
    fn computer_halt_reaches_dispatch() {
        let value = run("return await ronic.computer.haltStatus();").unwrap();
        assert_eq!(value["method"].as_str(), Some("computer.haltStatus"));
        let click = run("return await ronic.computer.somClick(3);").unwrap();
        assert_eq!(click["args"]["markId"].as_f64(), Some(3.0));
    }

    #[test]
    fn control_flow_comparisons_and_templates() {
        assert_eq!(run("if (1 > 0) { return 2; } else { return 3; }").unwrap().as_f64(), Some(2.0));
        assert_eq!(run("return (3 > 1) && !(2 > 5);").unwrap().as_bool(), Some(true));
        assert_eq!(run("return 1 < 2 ? 4 : 5;").unwrap().as_f64(), Some(4.0));
        assert_eq!(run(r#"const name = "workspace"; return `facts:${name}`;"#).unwrap().as_str(), Some("facts:workspace"));
        assert!(run("const o = null; return o?.a;").unwrap().is_null());
        let (value, calls) = run_calls("return true ? 1 : await ronic.skills.listIndex();").unwrap();
        assert!(calls.is_empty(), "{calls:?}");
        assert_eq!(value.as_f64(), Some(1.0));
        let (value, calls) = run_calls("const o = null; return o?.[await ronic.skills.listIndex()];").unwrap();
        assert!(calls.is_empty(), "{calls:?}");
        assert!(value.is_null());
    }

    #[test]
    fn loops_destructure_and_assignment() {
        assert_eq!(run("let n = 1; n = n + 2; return n;").unwrap().as_f64(), Some(3.0));
        assert!(run("const n = 1; n = 2; return n;").unwrap_err().contains("const"));
        let slug = run(
            r#"
            const skills = await ronic.skills.listIndex();
            const { slug } = skills[0];
            return slug;
            "#,
        )
        .unwrap();
        assert_eq!(slug.as_str(), Some("demo"));
        assert_eq!(run("let n = 0; for (const item of [1, 2, 3]) { n = n + item; } return n;").unwrap().as_f64(), Some(6.0));
        let mut nums = Vec::new();
        for i in 0..65 {
            nums.push(i.to_string());
        }
        let script = format!("let n = 0; for (const item of [{}]) {{ n = n + 1; }} return n;", nums.join(", "));
        let error = run(&script).unwrap_err();
        assert!(error.contains("64"), "{error}");
    }

    #[test]
    fn array_and_string_methods() {
        let found = run(
            r#"
            const skills = await ronic.skills.listIndex();
            const rows = skills.filter(s => s.slug == "demo");
            return rows.length;
            "#,
        )
        .unwrap();
        assert_eq!(found.as_f64(), Some(1.0));
        let mapped = run("return [1, 2, 3].map(n => n + 1);").unwrap();
        assert_eq!(mapped[0].as_f64(), Some(2.0));
        assert_eq!(mapped[2].as_f64(), Some(4.0));
        assert_eq!(run(r#"return "AbC".toLowerCase();"#).unwrap().as_str(), Some("abc"));
        assert_eq!(run(r#"return "a,b,c".split(",").length;"#).unwrap().as_f64(), Some(3.0));
        assert!(run("return (() => 1);").unwrap_err().contains("arrow"));
        let mut nums = Vec::new();
        for i in 0..65 {
            nums.push(i.to_string());
        }
        let script = format!("return [{}].filter(() => true).length;", nums.join(", "));
        let error = run(&script).unwrap_err();
        assert!(error.contains("64"), "{error}");
    }

    #[test]
    fn division_by_zero_and_proto_fail() {
        let shorthand = run(r#"const skillCount = 2; return { skillCount, label: "ok" };"#).unwrap();
        assert_eq!(shorthand["skillCount"].as_f64(), Some(2.0));
        assert_eq!(shorthand["label"].as_str(), Some("ok"));
        assert!(run("const row = { slug: \"demo\" }; return row.length;").unwrap().is_null());
        assert_eq!(run("const row = { length: 4 }; return row.length;").unwrap().as_f64(), Some(4.0));
        assert_eq!(run("const a = [1]; return a.concat([2, 3]).length;").unwrap().as_f64(), Some(3.0));
        let pushed = run(
            r#"
            let rows = [];
            const skills = await ronic.skills.listIndex();
            for (const item of skills) { if (item.slug == "demo") rows.push(item); }
            return rows.length;
            "#,
        )
        .unwrap();
        assert_eq!(pushed.as_f64(), Some(1.0));
        assert!(run("const rows = []; rows.push(1);").unwrap_err().contains("const"));
        assert_eq!(run("return `n:${1 + 2}`;").unwrap().as_str(), Some("n:3"));
        assert_eq!(run("return null ?? 5;").unwrap().as_f64(), Some(5.0));
        assert_eq!(run("return 0 ?? 5;").unwrap().as_f64(), Some(0.0));
        assert_eq!(run("return false ?? true;").unwrap().as_bool(), Some(false));
        let (value, calls) = run_calls("return 1 ?? await ronic.skills.listIndex();").unwrap();
        assert!(calls.is_empty(), "{calls:?}");
        assert_eq!(value.as_f64(), Some(1.0));
        assert!(run("const rows = null; return rows?.filter(s => true);").unwrap().is_null());
        assert!(run("const row = { a: 1 }; return row?.missing();").unwrap_err().contains("optional"));
        assert_eq!(run("return Object.keys({ b: 1, a: 2 }).length;").unwrap().as_f64(), Some(2.0));
        assert_eq!(run(r#"return Object.entries({ slug: "demo" })[0][0];"#).unwrap().as_str(), Some("slug"));
        assert_eq!(run("return [1, 2, 3].indexOf(2);").unwrap().as_f64(), Some(1.0));
        assert_eq!(run(r#"return "abc".indexOf("c");"#).unwrap().as_f64(), Some(2.0));
        assert_eq!(run("return [1].indexOf(9);").unwrap().as_f64(), Some(-1.0));
        let each = run("let rows = []; [1, 2].forEach(n => rows.push(n)); return rows.length;").unwrap();
        assert_eq!(each.as_f64(), Some(2.0));
        assert!(run("return 1 / 0;").unwrap_err().contains("zero"));
        assert!(run("const o = { a: 1 }; return o.__proto__;").unwrap_err().contains("property"));
        assert!(run(r#"const o = { a: 1 }; return o["constructor"];"#).unwrap_err().contains("property"));
    }
}
