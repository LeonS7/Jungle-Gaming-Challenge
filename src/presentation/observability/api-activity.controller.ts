/**
 * Esta página serve o console local e a consulta somente leitura das atividades.
 */
import {
  BadRequestException,
  Controller,
  Get,
  Header,
  Query,
} from '@nestjs/common';
import { ApiActivityLog } from '../../infrastructure/observability/api-activity-log.js';

const PAGE_SIZE = 100;

const ACTIVITY_CONSOLE_HTML = `<!doctype html>
<html lang="pt-BR">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="theme-color" content="#08101f">
  <title>Atividade da API | Jungle Gaming</title>
  <style>
    :root { color-scheme: dark; font-family: Inter, Segoe UI, Arial, sans-serif; background: #08101f; color: #e9edf7; }
    * { box-sizing: border-box; }
    body { margin: 0; min-height: 100vh; padding: 32px 20px; background: radial-gradient(ellipse at 12% 0%, #27204e 0, transparent 36%), #08101f; }
    main { max-width: 1180px; margin: 0 auto; }
    header, .painel, .rodape { border: 1px solid #26324b; border-radius: 16px; background: #101a2c; box-shadow: 0 18px 54px #0003; }
    header { padding: 24px 28px; margin-bottom: 18px; }
    .sobrelinha { color: #bba7ff; font-size: 12px; font-weight: 700; letter-spacing: .14em; text-transform: uppercase; }
    h1 { margin: 10px 0 8px; font-size: clamp(25px, 4vw, 36px); }
    p { color: #aab6cb; line-height: 1.55; margin: 0; }
    .estado { display: inline-flex; align-items: center; gap: 9px; margin-top: 18px; color: #aef0c1; font-size: 13px; font-weight: 700; }
    .ponto { width: 9px; height: 9px; border-radius: 50%; background: #4edb83; box-shadow: 0 0 12px #4edb83; }
    .painel { overflow: hidden; }
    .barra { display: flex; flex-wrap: wrap; justify-content: space-between; align-items: center; gap: 12px; padding: 16px 20px; border-bottom: 1px solid #26324b; }
    h2 { margin: 0; font-size: 16px; }
    #conexao { color: #aab6cb; font-size: 12px; }
    #aviso { display: none; padding: 10px 20px; color: #f7d58b; background: #382d16; font-size: 13px; }
    #registros { height: min(62vh, 620px); overflow: auto; padding: 8px 0; font: 12px/1.65 ui-monospace, SFMono-Regular, Consolas, monospace; }
    .linha { display: grid; grid-template-columns: 164px 1fr; gap: 12px; padding: 7px 20px; border-bottom: 1px solid #ffffff08; overflow-wrap: anywhere; }
    .horario { color: #8291ab; white-space: nowrap; }
    .mensagem { color: #d5deee; white-space: pre-wrap; }
    .nivel-error .mensagem { color: #ff9eaa; }
    .nivel-warn .mensagem { color: #f7d58b; }
    .nivel-debug .mensagem, .nivel-verbose .mensagem { color: #aab6cb; }
    .vazio { padding: 28px 20px; color: #8291ab; }
    .rodape { padding: 16px 20px; margin-top: 18px; color: #9eabc1; font-size: 12px; }
    .rotas { display: flex; flex-wrap: wrap; gap: 8px; margin-top: 12px; }
    a { color: #c2adff; text-decoration: none; border: 1px solid #473b71; border-radius: 8px; padding: 7px 10px; }
    a:hover { background: #211c39; }
    @media (max-width: 620px) { body { padding: 18px 12px; } header { padding: 20px; } .linha { grid-template-columns: 1fr; gap: 1px; padding: 8px 14px; } #registros { height: 58vh; } }
  </style>
</head>
<body>
  <main>
    <header>
      <div class="sobrelinha">Jungle Gaming · serviço HTTP</div>
      <h1>Console de atividade da API</h1>
      <p>Acompanhe requisições e eventos registrados por este processo enquanto testa a aplicação.</p>
      <div class="estado"><span class="ponto" aria-hidden="true"></span>API em execução</div>
    </header>
    <section class="painel" aria-labelledby="titulo-registros">
      <div class="barra"><h2 id="titulo-registros">Atividade recente</h2><span id="conexao" role="status">Conectando à API…</span></div>
      <div id="aviso" role="status"></div>
      <div id="registros" role="log" aria-live="polite" aria-relevant="additions">
        <div class="vazio">Aguardando atividade…</div>
      </div>
    </section>
    <section class="rodape">
      <div>Os registros HTTP não incluem corpo, cabeçalhos ou parâmetros da solicitação. O histórico é limitado, local a este processo e apagado ao reiniciar a API.</div>
      <nav class="rotas" aria-label="Rotas de consulta">
        <a href="/health/live">Saúde do processo</a>
        <a href="/health/ready">Prontidão de serviços</a>
        <a href="/metrics">Métricas</a>
      </nav>
    </section>
  </main>
  <script>
    const lista = document.getElementById('registros');
    const estado = document.getElementById('conexao');
    const aviso = document.getElementById('aviso');
    let cursor = null;
    let inicial = true;
    let aguardando = false;
    function adicionarRegistro(registro) {
      const linha = document.createElement('div');
      linha.className = 'linha nivel-' + registro.level;
      const horario = document.createElement('span');
      horario.className = 'horario';
      horario.textContent = new Date(registro.occurredAt).toLocaleTimeString('pt-BR');
      const mensagem = document.createElement('span');
      mensagem.className = 'mensagem';
      const contexto = registro.context ? '[' + registro.context + '] ' : '';
      mensagem.textContent = '[' + registro.level.toUpperCase() + '] ' + contexto + registro.message;
      linha.append(horario, mensagem);
      lista.appendChild(linha);
      while (lista.children.length > 500) lista.removeChild(lista.firstChild);
    }
    async function atualizar() {
      if (aguardando) return;
      aguardando = true;
      const parametros = new URLSearchParams();
      if (cursor !== null) parametros.set('after', String(cursor));
      const endereco = '/activity' + (parametros.size ? '?' + parametros.toString() : '');
      try {
        const resposta = await fetch(endereco, { cache: 'no-store' });
        if (!resposta.ok) throw new Error('A API respondeu com HTTP ' + resposta.status + '.');
        const pagina = await resposta.json();
        if (inicial && lista.querySelector('.vazio')) lista.replaceChildren();
        if (pagina.gap) {
          aviso.textContent = 'O início do histórico não está mais disponível; o buffer local é limitado.';
          aviso.style.display = 'block';
        }
        for (const registro of pagina.items) adicionarRegistro(registro);
        cursor = pagina.nextCursor;
        inicial = false;
        estado.textContent = 'Atualizado às ' + new Date().toLocaleTimeString('pt-BR');
        aguardando = false;
        window.setTimeout(atualizar, pagina.hasMore ? 0 : 1000);
      } catch (erro) {
        estado.textContent = erro instanceof Error ? erro.message : 'Não foi possível consultar os registros.';
        aguardando = false;
        window.setTimeout(atualizar, 2000);
      }
    }
    atualizar();
  </script>
</body>
</html>`;

function parseCursor(rawCursor: unknown): number | undefined {
  if (rawCursor === undefined) {
    return undefined;
  }
  if (typeof rawCursor !== 'string' || !/^(0|[1-9]\d*)$/.test(rawCursor)) {
    throw new BadRequestException({
      statusCode: 400,
      code: 'INVALID_REQUEST',
      message: 'O cursor de atividade deve ser um inteiro não negativo.',
    });
  }
  const cursor = Number(rawCursor);
  if (!Number.isSafeInteger(cursor)) {
    throw new BadRequestException({
      statusCode: 400,
      code: 'INVALID_REQUEST',
      message: 'O cursor de atividade está fora do intervalo permitido.',
    });
  }
  return cursor;
}

@Controller()
export class ApiActivityController {
  constructor(private readonly activityLog: ApiActivityLog) {}

  @Get()
  @Header('Content-Type', 'text/html; charset=utf-8')
  @Header('Cache-Control', 'no-store')
  openActivityConsole(): string {
    return ACTIVITY_CONSOLE_HTML;
  }

  @Get('activity')
  @Header('Content-Type', 'application/json; charset=utf-8')
  @Header('Cache-Control', 'no-store')
  readActivity(@Query('after') rawCursor: unknown) {
    return this.activityLog.readPage(parseCursor(rawCursor), PAGE_SIZE);
  }
}
