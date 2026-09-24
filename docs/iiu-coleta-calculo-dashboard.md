# IIU: coleta, cálculo e dashboard

Este documento registra a ideia de separar o IIU em tres camadas dentro do Decsys: coleta, calculo e dashboard.

## Objetivo

O Decsys deve permitir que pessoas leigas importem dados, entendam o que falta coletar, revisem os valores e visualizem o resultado no dashboard. Para o IIU, isso exige mais do que salvar planilhas: o sistema precisa guardar tambem a metodologia usada para transformar dados brutos em pontuacoes.

## Separacao das areas

A navegacao pode ser dividida em duas areas principais.

## Dados

Area operacional, voltada para preparar a base:

- Importacoes
- Dados revisados
- Indicadores
- Cadastro de indicador
- Fontes

## Paineis

Area analitica, voltada para leitura dos resultados:

- IIU - Visao geral
- IIU - Coleta
- IIU - Pesos
- IIU - Calculo
- Futuros dashboards, como veiculos eletricos

Essa separacao evita misturar telas de tratamento de dados com telas de interpretacao do painel.

## Pagina de coleta do IIU

A pagina de coleta corresponde ao Passo 3 do HTML de referencia. Ela deve responder:

- quais indicadores ja tem dado aprovado;
- quais indicadores ainda estao sem dado;
- quais podem ser coletados por fonte publica;
- quais exigem arquivo ou link manual;
- quais exigem visita presencial;
- quais dependem de estrategia alternativa.

Hoje o Decsys ja guarda fontes, imports, linhas importadas, indicadores e valores aprovados. Isso permite mostrar uma versao basica da cobertura. O que ainda falta e uma estrutura formal para classificar o metodo de coleta de cada indicador.

Uma estrutura futura poderia guardar, por indicador:

- metodo de coleta: automatica, arquivo/link, visita presencial ou alternativa;
- base recomendada: IBGE, DATASUS, SNIS, ANEEL, ANATEL, CGU, SSP, MapBiomas;
- URL ou referencia da fonte;
- esforco estimado;
- adaptador disponivel ou nao;
- observacao metodologica;
- status calculado a partir dos dados aprovados.

Com isso, a pagina conseguiria mostrar algo como:

```text
29 indicadores coletaveis remotamente
7 indicadores exigem visita
6 indicadores dependem de estrategia alternativa
```

E tambem uma leitura por indicador:

```text
PIB per capita municipal
Metodo: fonte publica
Fonte sugerida: IBGE
Status: aprovado
Ultima referencia: 2021

Digitalizacao do transporte
Metodo: visita presencial
Status: sem dado aprovado
Fonte sugerida: checklist municipal
```

## Pagina de calculo do IIU

A pagina de calculo corresponde ao Passo 4 do HTML de referencia. Ela deve explicar e permitir revisar como o valor bruto vira pontuacao de 0 a 100.

Hoje o projeto ja possui boa parte dessa base:

- direcao do score: direto, inverso ou checklist;
- formula textual do indicador;
- valor maximo para indicadores de checklist;
- benchmarks P10 e P90 por porte de municipio;
- pesos por dimensao e porte;
- calculo do dashboard usando essas configuracoes.

Essa pagina deve permitir visualizar e, futuramente, editar:

- pesos por dimensao e porte;
- direcao de calculo do indicador;
- limites minimo e maximo usados na normalizacao;
- limite maximo de checklist;
- escala de maturidade do IIU.

Quando uma dessas configuracoes mudar, o dashboard deve recalcular a pontuacao usando os mesmos dados aprovados. Assim, nao e necessario reimportar a planilha para ajustar a metodologia.

## Relação entre as camadas

O fluxo ideal fica assim:

```text
Importacao
  -> revisao e aprovacao dos dados
  -> valores publicados
  -> configuracao de coleta e calculo
  -> dashboard IIU
```

A pagina de coleta responde de onde vem cada dado e o que falta. A pagina de calculo responde como o dado bruto vira score. O dashboard responde qual e o resultado final do municipio.

## Mudancas recomendadas

1. Criar uma tabela de configuracao de coleta dos indicadores IIU.
2. Criar a pagina `IIU > Coleta`, cruzando configuracao metodologica com dados aprovados.
3. Criar a pagina `IIU > Pesos`, lendo os pesos oficiais por porte.
4. Criar a pagina `IIU > Calculo`, lendo direcao, benchmark, checklist e maturidade.
5. Fazer o dashboard sempre calcular a partir dessas configuracoes.

Essa arquitetura prepara o Decsys para outros dashboards no futuro, sem misturar dados municipais com outros dominios como veiculos eletricos.
