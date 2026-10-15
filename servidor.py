#!/usr/bin/env python3
"""Servidor local do Detector facial.

Serve o site e guarda tudo no arquivo banco.json (usuários, pessoas cadastradas,
registro de presença e dados das fotos). As imagens das fotos ficam na pasta fotos/.

Só usa a biblioteca padrão do Python (3.8 ou mais novo). Para rodar:

    python servidor.py

O servidor só aceita conexões deste computador (127.0.0.1).
"""
import argparse
import base64
import binascii
import hashlib
import hmac
import http.server
import json
import math
import os
import re
import secrets
import socketserver
import sys
import threading
import time
import traceback
import webbrowser
from http import cookies
from urllib.parse import urlparse

PASTA = os.path.dirname(os.path.abspath(__file__))
ARQ_BANCO = os.path.join(PASTA, "banco.json")
PASTA_FOTOS = os.path.join(PASTA, "fotos")

# Só estes arquivos do site são servidos. banco.json, servidor.py e o resto nunca saem daqui.
ESTATICOS = {"/": "index.html", "/index.html": "index.html", "/style.css": "style.css", "/app.js": "app.js"}
TIPOS = {
    ".html": "text/html; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".js": "application/javascript; charset=utf-8",
}

SESSAO_SEGUNDOS = 12 * 3600
PBKDF2_ITERACOES = 200_000
LIMITE_JSON = 1_000_000
LIMITE_FOTO = 8_000_000
MAX_FOTO_BYTES = 6_000_000
MAX_PRESENCAS = 20_000
TENTATIVAS_LOGIN = 5
JANELA_LOGIN = 60

ID_RE = r"[0-9a-f]{16}"
USUARIO_RE = re.compile(r"^[a-z0-9._-]{3,30}$")
HOSTS_OK = {"localhost", "127.0.0.1", "[::1]"}


def agora_ms():
    return int(time.time() * 1000)


def novo_id():
    return secrets.token_hex(8)


def limpa_texto(valor, maximo):
    """Devolve o texto sem caracteres de controle e com espaços normalizados, ou None se for inválido."""
    if not isinstance(valor, str):
        return None
    valor = re.sub(r"[\x00-\x1f\x7f]", " ", valor)
    valor = " ".join(valor.split())
    return valor if 1 <= len(valor) <= maximo else None


# ---------------------------------------------------------------- senhas

def hash_senha(senha, sal=None, iteracoes=PBKDF2_ITERACOES):
    sal = sal or secrets.token_bytes(16)
    h = hashlib.pbkdf2_hmac("sha256", senha.encode("utf-8"), sal, iteracoes)
    return {"algoritmo": "pbkdf2-sha256", "iteracoes": iteracoes, "sal": sal.hex(), "hash": h.hex()}


def confere_senha(senha, registro):
    try:
        h = hashlib.pbkdf2_hmac(
            "sha256", senha.encode("utf-8"), bytes.fromhex(registro["sal"]), int(registro["iteracoes"])
        )
        return hmac.compare_digest(h.hex(), registro["hash"])
    except (KeyError, ValueError, TypeError):
        return False


SENHA_FALSA = hash_senha("senha-falsa-para-igualar-o-tempo")


# ---------------------------------------------------------------- banco.json

class Banco:
    def __init__(self, caminho):
        self.caminho = caminho
        self.trava = threading.RLock()
        self.dados = self._carregar()

    @staticmethod
    def _vazio():
        return {"versao": 1, "usuarios": [], "pessoas": [], "presencas": [], "fotos": []}

    def _carregar(self):
        if not os.path.exists(self.caminho):
            dados = self._vazio()
            self._gravar(dados)
            return dados
        try:
            with open(self.caminho, "r", encoding="utf-8") as f:
                dados = json.load(f)
            if not isinstance(dados, dict):
                raise ValueError("o arquivo não é um objeto JSON")
        except (ValueError, OSError) as erro:
            copia = self.caminho + ".corrompido-" + time.strftime("%Y%m%d-%H%M%S")
            try:
                os.replace(self.caminho, copia)
            except OSError:
                pass
            print(f"Aviso: não consegui ler o banco.json ({erro}). Guardei o arquivo como {os.path.basename(copia)} e criei um banco novo.")
            dados = self._vazio()
            self._gravar(dados)
            return dados
        for chave, padrao in self._vazio().items():
            if chave not in dados or (chave != "versao" and not isinstance(dados[chave], list)):
                dados[chave] = padrao
        return dados

    def _gravar(self, dados):
        texto = json.dumps(dados, ensure_ascii=False, indent=2)
        # Listas só de números (os dados do rosto) ficam em uma linha, para o arquivo continuar legível.
        numero = r"-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?"
        texto = re.sub(
            r"\[\s*(?:" + numero + r"\s*,\s*)*" + numero + r"\s*\]",
            lambda m: re.sub(r"\s*\n\s*", " ", m.group(0)),
            texto,
        )
        tmp = self.caminho + ".tmp"
        with open(tmp, "w", encoding="utf-8") as f:
            f.write(texto)
            f.flush()
            os.fsync(f.fileno())
        os.replace(tmp, self.caminho)

    def salvar(self):
        with self.trava:
            self._gravar(self.dados)


BANCO = None
SESSOES = {}          # token -> {"uid": ..., "exp": ...}
TRAVA_SESSOES = threading.Lock()
FALHAS = {}           # (ip, usuario) -> [instantes]
TRAVA_FALHAS = threading.Lock()


def criar_sessao(uid):
    token = secrets.token_urlsafe(32)
    with TRAVA_SESSOES:
        agora = time.time()
        for t in [t for t, s in SESSOES.items() if s["exp"] < agora]:
            del SESSOES[t]
        SESSOES[token] = {"uid": uid, "exp": agora + SESSAO_SEGUNDOS}
    return token


def usuario_publico(u):
    return {"id": u["id"], "nome": u["nome"], "usuario": u["usuario"], "papel": u["papel"], "criadoEm": u.get("criadoEm")}


# ---------------------------------------------------------------- validação

def valida_descritores(lista):
    if not isinstance(lista, list) or not 1 <= len(lista) <= 20:
        return None
    saida = []
    for d in lista:
        if not isinstance(d, list) or len(d) != 128:
            return None
        linha = []
        for x in d:
            if isinstance(x, bool) or not isinstance(x, (int, float)) or not math.isfinite(x) or abs(x) > 10:
                return None
            linha.append(round(float(x), 5))
        saida.append(linha)
    return saida


def valida_senha(senha):
    return isinstance(senha, str) and 6 <= len(senha) <= 200


class ErroHttp(Exception):
    def __init__(self, status, mensagem):
        super().__init__(mensagem)
        self.status = status
        self.mensagem = mensagem


# ---------------------------------------------------------------- rotas da API

class Api:
    """Cada método recebe (usuário logado ou None, corpo JSON, *grupos da rota, ip) e devolve (status, dados, cabeçalhos)."""

    # -- sessão
    def estado(self, usuario, corpo, ip):
        with BANCO.trava:
            vazio = not BANCO.dados["usuarios"]
        return 200, {"precisaCriarAdmin": vazio, "usuario": usuario_publico(usuario) if usuario else None}, {}

    def configurar(self, usuario, corpo, ip):
        nome = limpa_texto(corpo.get("nome"), 40)
        login = str(corpo.get("usuario", "")).strip().lower()
        senha = corpo.get("senha")
        if not nome:
            raise ErroHttp(400, "Informe o seu nome.")
        if not USUARIO_RE.match(login):
            raise ErroHttp(400, "O usuário deve ter de 3 a 30 letras minúsculas, números, ponto, hífen ou sublinhado.")
        if not valida_senha(senha):
            raise ErroHttp(400, "A senha deve ter pelo menos 6 caracteres.")
        with BANCO.trava:
            if BANCO.dados["usuarios"]:
                raise ErroHttp(403, "O primeiro usuário já foi criado. Entre com a sua conta.")
            u = {"id": novo_id(), "nome": nome, "usuario": login, "senha": hash_senha(senha), "papel": "admin", "criadoEm": agora_ms()}
            BANCO.dados["usuarios"].append(u)
            BANCO.salvar()
        token = criar_sessao(u["id"])
        return 200, usuario_publico(u), {"Set-Cookie": cookie_sessao(token)}

    def entrar(self, usuario, corpo, ip):
        login = str(corpo.get("usuario", "")).strip().lower()
        senha = corpo.get("senha")
        if not isinstance(senha, str) or not login:
            raise ErroHttp(400, "Preencha usuário e senha.")
        chave = (ip, login)
        agora = time.time()
        with TRAVA_FALHAS:
            recentes = [t for t in FALHAS.get(chave, []) if agora - t < JANELA_LOGIN]
            FALHAS[chave] = recentes
            if len(recentes) >= TENTATIVAS_LOGIN:
                raise ErroHttp(429, "Muitas tentativas erradas. Espere 1 minuto e tente de novo.")
        with BANCO.trava:
            u = next((x for x in BANCO.dados["usuarios"] if x["usuario"] == login), None)
        ok = confere_senha(senha, u["senha"] if u else SENHA_FALSA)
        if not (u and ok):
            with TRAVA_FALHAS:
                FALHAS.setdefault(chave, []).append(time.time())
            raise ErroHttp(401, "Usuário ou senha incorretos.")
        with TRAVA_FALHAS:
            FALHAS.pop(chave, None)
        token = criar_sessao(u["id"])
        return 200, usuario_publico(u), {"Set-Cookie": cookie_sessao(token)}

    def sair(self, usuario, corpo, ip, token=None):
        if token:
            with TRAVA_SESSOES:
                SESSOES.pop(token, None)
        return 200, {"ok": True}, {"Set-Cookie": cookie_sessao("", apagar=True)}

    # -- usuários (só administrador)
    def usuarios_listar(self, usuario, corpo, ip):
        with BANCO.trava:
            return 200, [usuario_publico(u) for u in BANCO.dados["usuarios"]], {}

    def usuarios_criar(self, usuario, corpo, ip):
        nome = limpa_texto(corpo.get("nome"), 40)
        login = str(corpo.get("usuario", "")).strip().lower()
        senha = corpo.get("senha")
        papel = corpo.get("papel", "usuario")
        if not nome:
            raise ErroHttp(400, "Informe o nome.")
        if not USUARIO_RE.match(login):
            raise ErroHttp(400, "O usuário deve ter de 3 a 30 letras minúsculas, números, ponto, hífen ou sublinhado.")
        if not valida_senha(senha):
            raise ErroHttp(400, "A senha deve ter pelo menos 6 caracteres.")
        if papel not in ("admin", "usuario"):
            raise ErroHttp(400, "Papel inválido.")
        with BANCO.trava:
            if any(x["usuario"] == login for x in BANCO.dados["usuarios"]):
                raise ErroHttp(409, "Esse usuário já existe.")
            u = {"id": novo_id(), "nome": nome, "usuario": login, "senha": hash_senha(senha), "papel": papel, "criadoEm": agora_ms()}
            BANCO.dados["usuarios"].append(u)
            BANCO.salvar()
        return 201, usuario_publico(u), {}

    def usuarios_apagar(self, usuario, corpo, ip, uid):
        with BANCO.trava:
            alvo = next((x for x in BANCO.dados["usuarios"] if x["id"] == uid), None)
            if not alvo:
                raise ErroHttp(404, "Usuário não encontrado.")
            if alvo["id"] == usuario["id"]:
                raise ErroHttp(400, "Você não pode apagar a própria conta.")
            if alvo["papel"] == "admin" and sum(1 for x in BANCO.dados["usuarios"] if x["papel"] == "admin") <= 1:
                raise ErroHttp(400, "Precisa existir pelo menos um administrador.")
            BANCO.dados["usuarios"] = [x for x in BANCO.dados["usuarios"] if x["id"] != uid]
            BANCO.salvar()
        with TRAVA_SESSOES:
            for t in [t for t, s in SESSOES.items() if s["uid"] == uid]:
                del SESSOES[t]
        return 200, {"ok": True}, {}

    # -- pessoas cadastradas
    def pessoas_listar(self, usuario, corpo, ip):
        with BANCO.trava:
            return 200, list(BANCO.dados["pessoas"]), {}

    def pessoas_criar(self, usuario, corpo, ip):
        nome = limpa_texto(corpo.get("nome"), 40)
        desc = valida_descritores(corpo.get("descritores"))
        if not nome:
            raise ErroHttp(400, "Informe o nome da pessoa.")
        if desc is None:
            raise ErroHttp(400, "Dados do rosto inválidos.")
        with BANCO.trava:
            if any(p["nome"].lower() == nome.lower() for p in BANCO.dados["pessoas"]):
                raise ErroHttp(409, "Já existe uma pessoa com esse nome.")
            p = {"id": novo_id(), "nome": nome, "descritores": desc, "criadoEm": agora_ms(), "criadoPor": usuario["usuario"]}
            BANCO.dados["pessoas"].append(p)
            BANCO.salvar()
        return 201, p, {}

    def pessoas_atualizar(self, usuario, corpo, ip, pid):
        desc = valida_descritores(corpo.get("descritores"))
        if desc is None:
            raise ErroHttp(400, "Dados do rosto inválidos.")
        with BANCO.trava:
            p = next((x for x in BANCO.dados["pessoas"] if x["id"] == pid), None)
            if not p:
                raise ErroHttp(404, "Pessoa não encontrada.")
            p["descritores"] = desc
            p["atualizadoEm"] = agora_ms()
            BANCO.salvar()
            return 200, p, {}

    def pessoas_apagar(self, usuario, corpo, ip, pid):
        with BANCO.trava:
            antes = len(BANCO.dados["pessoas"])
            BANCO.dados["pessoas"] = [x for x in BANCO.dados["pessoas"] if x["id"] != pid]
            if len(BANCO.dados["pessoas"]) == antes:
                raise ErroHttp(404, "Pessoa não encontrada.")
            BANCO.salvar()
        return 200, {"ok": True}, {}

    def pessoas_apagar_todas(self, usuario, corpo, ip):
        with BANCO.trava:
            BANCO.dados["pessoas"] = []
            BANCO.salvar()
        return 200, {"ok": True}, {}

    # -- presença
    def presencas_listar(self, usuario, corpo, ip):
        with BANCO.trava:
            return 200, list(BANCO.dados["presencas"]), {}

    def presencas_criar(self, usuario, corpo, ip):
        nome = limpa_texto(corpo.get("pessoa"), 40)
        entrada, saida = corpo.get("entrada"), corpo.get("saida")
        limite = agora_ms() + 24 * 3600 * 1000
        ints = all(isinstance(v, int) and not isinstance(v, bool) for v in (entrada, saida))
        if not nome or not ints or not (0 < entrada <= saida <= limite):
            raise ErroHttp(400, "Registro de presença inválido.")
        pid = corpo.get("pessoaId")
        if not (isinstance(pid, str) and re.fullmatch(ID_RE, pid)):
            pid = None
        reg = {"id": novo_id(), "pessoa": nome, "pessoaId": pid, "entrada": entrada, "saida": saida, "registradoPor": usuario["usuario"]}
        with BANCO.trava:
            BANCO.dados["presencas"].append(reg)
            if len(BANCO.dados["presencas"]) > MAX_PRESENCAS:
                BANCO.dados["presencas"] = BANCO.dados["presencas"][-MAX_PRESENCAS:]
            BANCO.salvar()
        return 201, reg, {}

    def presencas_apagar_todas(self, usuario, corpo, ip):
        with BANCO.trava:
            BANCO.dados["presencas"] = []
            BANCO.salvar()
        return 200, {"ok": True}, {}

    # -- fotos
    def fotos_listar(self, usuario, corpo, ip):
        with BANCO.trava:
            return 200, sorted(BANCO.dados["fotos"], key=lambda f: f["criadoEm"], reverse=True), {}

    def fotos_criar(self, usuario, corpo, ip):
        img = corpo.get("imagem")
        prefixo = "data:image/jpeg;base64,"
        if not isinstance(img, str) or not img.startswith(prefixo):
            raise ErroHttp(400, "Imagem inválida: envie um JPEG.")
        try:
            dados = base64.b64decode(img[len(prefixo):], validate=True)
        except (binascii.Error, ValueError):
            raise ErroHttp(400, "Imagem inválida.")
        if len(dados) > MAX_FOTO_BYTES:
            raise ErroHttp(413, "A foto é grande demais.")
        if not dados.startswith(b"\xff\xd8\xff"):
            raise ErroHttp(400, "O arquivo não é um JPEG.")
        nomes = []
        if isinstance(corpo.get("pessoas"), list):
            nomes = [n for n in (limpa_texto(x, 40) for x in corpo["pessoas"][:10]) if n]
        foto_id = novo_id()
        os.makedirs(PASTA_FOTOS, exist_ok=True)
        with open(os.path.join(PASTA_FOTOS, foto_id + ".jpg"), "wb") as f:
            f.write(dados)
        reg = {"id": foto_id, "arquivo": f"fotos/{foto_id}.jpg", "criadoEm": agora_ms(), "criadoPor": usuario["usuario"], "pessoas": nomes}
        with BANCO.trava:
            BANCO.dados["fotos"].append(reg)
            BANCO.salvar()
        return 201, reg, {}

    @staticmethod
    def _apaga_arquivo(foto_id):
        try:
            os.remove(os.path.join(PASTA_FOTOS, foto_id + ".jpg"))
        except OSError:
            pass

    def fotos_apagar(self, usuario, corpo, ip, fid):
        with BANCO.trava:
            antes = len(BANCO.dados["fotos"])
            BANCO.dados["fotos"] = [x for x in BANCO.dados["fotos"] if x["id"] != fid]
            if len(BANCO.dados["fotos"]) == antes:
                raise ErroHttp(404, "Foto não encontrada.")
            BANCO.salvar()
        self._apaga_arquivo(fid)
        return 200, {"ok": True}, {}

    def fotos_apagar_todas(self, usuario, corpo, ip):
        with BANCO.trava:
            ids = [f["id"] for f in BANCO.dados["fotos"]]
            BANCO.dados["fotos"] = []
            BANCO.salvar()
        for fid in ids:
            self._apaga_arquivo(fid)
        return 200, {"ok": True}, {}


def cookie_sessao(token, apagar=False):
    if apagar:
        return "sid=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0"
    return f"sid={token}; HttpOnly; SameSite=Strict; Path=/; Max-Age={SESSAO_SEGUNDOS}"


API = Api()

# (método, padrão, função, quem pode, limite do corpo)
ROTAS = [
    ("GET", r"/api/estado", API.estado, None, 0),
    ("POST", r"/api/configurar", API.configurar, None, LIMITE_JSON),
    ("POST", r"/api/entrar", API.entrar, None, LIMITE_JSON),
    ("POST", r"/api/sair", API.sair, None, 0),
    ("GET", r"/api/usuarios", API.usuarios_listar, "admin", 0),
    ("POST", r"/api/usuarios", API.usuarios_criar, "admin", LIMITE_JSON),
    ("DELETE", rf"/api/usuarios/({ID_RE})", API.usuarios_apagar, "admin", 0),
    ("GET", r"/api/pessoas", API.pessoas_listar, "login", 0),
    ("POST", r"/api/pessoas", API.pessoas_criar, "login", LIMITE_JSON),
    ("PUT", rf"/api/pessoas/({ID_RE})", API.pessoas_atualizar, "login", LIMITE_JSON),
    ("DELETE", rf"/api/pessoas/({ID_RE})", API.pessoas_apagar, "login", 0),
    ("DELETE", r"/api/pessoas", API.pessoas_apagar_todas, "login", 0),
    ("GET", r"/api/presencas", API.presencas_listar, "login", 0),
    ("POST", r"/api/presencas", API.presencas_criar, "login", LIMITE_JSON),
    ("DELETE", r"/api/presencas", API.presencas_apagar_todas, "login", 0),
    ("GET", r"/api/fotos", API.fotos_listar, "login", 0),
    ("POST", r"/api/fotos", API.fotos_criar, "login", LIMITE_FOTO),
    ("DELETE", rf"/api/fotos/({ID_RE})", API.fotos_apagar, "login", 0),
    ("DELETE", r"/api/fotos", API.fotos_apagar_todas, "login", 0),
]
ROTAS = [(m, re.compile("^" + p + "$"), f, a, lim) for m, p, f, a, lim in ROTAS]


# ---------------------------------------------------------------- HTTP

class Servidor(socketserver.ThreadingMixIn, http.server.HTTPServer):
    daemon_threads = True
    # No Windows, reaproveitar a porta deixaria dois servidores abrirem a mesma porta.
    allow_reuse_address = os.name != "nt"


class Pedido(http.server.BaseHTTPRequestHandler):
    server_version = "DetectorFacial/1.0"

    def log_message(self, formato, *args):
        pass

    # -- respostas
    def _enviar(self, status, tipo, corpo, extra=None, cache="no-store"):
        self.send_response(status)
        self.send_header("Content-Type", tipo)
        self.send_header("Content-Length", str(len(corpo)))
        self.send_header("Cache-Control", cache)
        self.send_header("X-Content-Type-Options", "nosniff")
        self.send_header("Referrer-Policy", "no-referrer")
        for k, v in (extra or {}).items():
            self.send_header(k, v)
        self.end_headers()
        if self.command != "HEAD":
            self.wfile.write(corpo)

    def _json(self, status, dados, extra=None):
        self._enviar(status, "application/json; charset=utf-8", json.dumps(dados, ensure_ascii=False).encode("utf-8"), extra)

    def _erro(self, status, mensagem):
        self._json(status, {"erro": mensagem})

    # -- entrada
    def _host_ok(self):
        host = self.headers.get("Host", "")
        nome = host.rsplit(":", 1)[0] if not host.startswith("[") else host.split("]")[0] + "]"
        return nome in HOSTS_OK

    def _origem_ok(self):
        origem = self.headers.get("Origin")
        return not origem or urlparse(origem).netloc == self.headers.get("Host", "")

    def _token(self):
        try:
            c = cookies.SimpleCookie(self.headers.get("Cookie", ""))
        except cookies.CookieError:
            return None
        return c["sid"].value if "sid" in c else None

    def _usuario(self):
        token = self._token()
        if not token:
            return None
        with TRAVA_SESSOES:
            s = SESSOES.get(token)
            if not s or s["exp"] < time.time():
                SESSOES.pop(token, None)
                return None
            uid = s["uid"]
        with BANCO.trava:
            return next((u for u in BANCO.dados["usuarios"] if u["id"] == uid), None)

    def _corpo(self, limite):
        if limite == 0:
            return {}
        tamanho = int(self.headers.get("Content-Length") or 0)
        if tamanho > limite:
            raise ErroHttp(413, "Pedido grande demais.")
        if tamanho == 0:
            return {}
        if not (self.headers.get("Content-Type") or "").lower().startswith("application/json"):
            raise ErroHttp(415, "Envie os dados como JSON.")
        try:
            dados = json.loads(self.rfile.read(tamanho).decode("utf-8"))
        except (ValueError, UnicodeDecodeError):
            raise ErroHttp(400, "JSON inválido.")
        if not isinstance(dados, dict):
            raise ErroHttp(400, "O corpo deve ser um objeto JSON.")
        return dados

    # -- roteamento
    def _tratar(self):
        try:
            if not self._host_ok():
                return self._erro(403, "Acesse por http://localhost.")
            caminho = urlparse(self.path).path
            if caminho.startswith("/api/"):
                return self._api(caminho)
            m = re.fullmatch(rf"/fotos/({ID_RE})\.jpg", caminho)
            if m and self.command in ("GET", "HEAD"):
                return self._foto(m.group(1))
            if caminho in ESTATICOS and self.command in ("GET", "HEAD"):
                return self._estatico(ESTATICOS[caminho])
            if caminho == "/favicon.ico":
                return self._enviar(204, "image/x-icon", b"")
            self._erro(404, "Não encontrado.")
        except ErroHttp as e:
            self._erro(e.status, e.mensagem)
        except (BrokenPipeError, ConnectionResetError):
            pass
        except Exception:
            traceback.print_exc()
            try:
                self._erro(500, "Erro interno do servidor.")
            except Exception:
                pass

    do_GET = do_HEAD = do_POST = do_PUT = do_DELETE = _tratar

    def _api(self, caminho):
        achou = False
        for metodo, padrao, funcao, quem, limite in ROTAS:
            m = padrao.match(caminho)
            if not m:
                continue
            achou = True
            if metodo != self.command:
                continue
            if self.command != "GET" and not self._origem_ok():
                raise ErroHttp(403, "Origem não permitida.")
            usuario = self._usuario()
            if quem in ("login", "admin") and not usuario:
                raise ErroHttp(401, "Faça login para continuar.")
            if quem == "admin" and usuario["papel"] != "admin":
                raise ErroHttp(403, "Só administradores podem fazer isso.")
            corpo = self._corpo(limite)
            ip = self.client_address[0]
            extra = {"token": self._token()} if funcao == API.sair else {}
            status, dados, cab = funcao(usuario, corpo, ip, *m.groups(), **extra)
            return self._json(status, dados, cab)
        raise ErroHttp(405 if achou else 404, "Método não permitido." if achou else "Não encontrado.")

    def _estatico(self, nome):
        with open(os.path.join(PASTA, nome), "rb") as f:
            corpo = f.read()
        self._enviar(200, TIPOS[os.path.splitext(nome)[1]], corpo, cache="no-cache")

    def _foto(self, foto_id):
        if not self._usuario():
            raise ErroHttp(401, "Faça login para ver as fotos.")
        try:
            with open(os.path.join(PASTA_FOTOS, foto_id + ".jpg"), "rb") as f:
                corpo = f.read()
        except OSError:
            raise ErroHttp(404, "Foto não encontrada.")
        self._enviar(200, "image/jpeg", corpo, cache="private, max-age=3600")


def abrir_servidor(porta):
    for p in range(porta, porta + 10):
        try:
            return Servidor(("127.0.0.1", p), Pedido), p
        except OSError:
            continue
    return None, None


def main():
    global BANCO
    try:
        sys.stdout.reconfigure(encoding="utf-8")
    except Exception:
        pass
    ap = argparse.ArgumentParser(description="Servidor local do Detector facial")
    ap.add_argument("--porta", type=int, default=8000, help="porta inicial (padrão 8000)")
    ap.add_argument("--sem-navegador", action="store_true", help="não abrir o navegador sozinho")
    args = ap.parse_args()

    BANCO = Banco(ARQ_BANCO)
    srv, porta = abrir_servidor(args.porta)
    if not srv:
        print(f"Não consegui abrir nenhuma porta entre {args.porta} e {args.porta + 9}. Feche o que estiver usando essas portas.")
        sys.exit(1)

    url = f"http://localhost:{porta}"
    print("Detector facial")
    print(f"  Site:   {url}")
    print(f"  Banco:  {ARQ_BANCO}")
    print(f"  Fotos:  {PASTA_FOTOS}")
    print("Para encerrar, feche esta janela ou aperte Ctrl+C.")
    if not args.sem_navegador:
        threading.Timer(0.8, webbrowser.open, [url]).start()
    try:
        srv.serve_forever()
    except KeyboardInterrupt:
        print("\nServidor encerrado.")
    finally:
        srv.server_close()


if __name__ == "__main__":
    main()
