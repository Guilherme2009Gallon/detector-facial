# Detector facial

Site de detecção facial em tempo real com MediaPipe (Face Landmarker) e reconhecimento de pessoas cadastradas com face-api.js. Os dados ficam num banco local, o arquivo `banco.json`, gerenciado por um servidor pequeno em Python.

## Como rodar

Precisa do Python 3.8 ou mais novo. Não precisa instalar nada além dele.

- **Windows:** dê dois cliques em `iniciar.bat`.
- **Qualquer sistema:** abra um terminal dentro desta pasta e rode `python servidor.py`.

O navegador abre sozinho em `http://localhost:8000`. Use o Chrome ou o Edge e permita a câmera. Precisa de internet na primeira abertura para baixar o MediaPipe, a face-api.js, os modelos e a fonte.

Na primeira vez o site pede para criar o primeiro usuário, que vira administrador. Depois disso, o login é obrigatório.

## Arquivos

- `index.html`, `style.css`, `app.js`: o site.
- `servidor.py`: servidor local e banco de dados.
- `banco.json`: criado no primeiro uso. Guarda usuários, pessoas cadastradas, presença e dados das fotos.
- `fotos/`: imagens das fotos capturadas, criada no primeiro uso.
- `iniciar.bat`: atalho para abrir o servidor no Windows.

## O que o site faz

- Detecta até 4 rostos pela câmera ou numa foto enviada.
- Desenha malha, contornos e marcador em cada rosto (cada um liga e desliga).
- Lê sorriso, boca aberta, piscadas e sobrancelhas, e dá um rótulo à expressão.
- Mostra a direção da cabeça, a inclinação e se a atenção está na câmera.
- Conta piscadas no último minuto e avisa quando os olhos ficam fechados por 1,5 s ou mais (possível sonolência).
- Cadastra pessoas pelo nome e mostra o nome quando elas aparecem na imagem.
- Registra a presença das pessoas cadastradas, com download em CSV e cumprimento opcional por voz.
- Captura fotos e guarda no banco. "Ocultar rostos" pixeliza o rosto na imagem e nas fotos.
- Login com usuários. O administrador cria e remove contas no botão "Usuários".

## Banco de dados

O `banco.json` tem quatro listas:

| Lista | Conteúdo |
| --- | --- |
| `usuarios` | nome, usuário, papel (`admin` ou `usuario`) e a senha em hash PBKDF2-SHA256 com sal |
| `pessoas` | nome e os dados numéricos do rosto (128 números por amostra) |
| `presencas` | pessoa, entrada e saída, em milissegundos desde 1970 |
| `fotos` | arquivo em `fotos/`, data, quem tirou e quem aparecia |

O servidor grava o arquivo de forma segura (escreve num temporário e troca), então uma queda de energia no meio não corrompe o banco. Se o `banco.json` ficar ilegível, ele é guardado como `banco.json.corrompido-DATA` e um banco novo é criado.

Para fazer backup, copie o `banco.json` e a pasta `fotos/`.

## Segurança e privacidade

- O servidor só aceita conexões do próprio computador (`127.0.0.1`).
- Senhas nunca ficam em texto puro. Depois de 5 tentativas erradas, o login espera 1 minuto.
- Só `index.html`, `style.css` e `app.js` são servidos. O `banco.json` não pode ser baixado pelo navegador.
- O rosto é dado biométrico: cadastre apenas quem concordou. O `banco.json` e a pasta `fotos/` não devem ir para o GitHub (o `.gitignore` já bloqueia os dois).
- A sessão de login dura 12 horas e é perdida se o servidor for reiniciado.

## Ajustes

No `app.js`:
- `MATCH_MAX` (padrão 0.5) controla o rigor do reconhecimento. Diminua se o site confundir pessoas e aumente se ele não reconhecer quem está cadastrado.
- `YAW_MAX`, `PITCH_MIN`, `PITCH_MAX`, `ROLL_MAX` e `DROWSY_MS` definem a atenção e o alerta de sonolência. A inclinação para cima e para baixo depende do ângulo da câmera: se aparecer "para cima" ou "para baixo" com você olhando reto, ajuste `PITCH_MIN` e `PITCH_MAX`.

No servidor, `python servidor.py --porta 9000` muda a porta e `--sem-navegador` impede que o navegador abra sozinho.
