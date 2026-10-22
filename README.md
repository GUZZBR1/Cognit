# Cognit — sinais experimentais de automação

O coletor [browser-automation-signals.js](browser-automation-signals.js) registra sinais heurísticos observáveis na página atual. Ele retorna JSON localmente quando chamado; não envia nem armazena dados e não classifica a pessoa como bot ou humana.

## Executar

Carregue o arquivo como script na página e chame `CognitAutomationSignals.collect(window)` no console do navegador. O retorno contém `schemaVersion`, um resumo cauteloso, uma lista de sinais observados ou ausentes e limitações. Cada entrada inclui id, alvo provável, força indicativa, evidência e limitação.

O coletor só é executado quando chamado. Ele não cria identificador, não usa armazenamento e não faz requisições de rede.

## Sinais cobertos

| Sinal | Alvo indicativo | Limitações principais |
| --- | --- | --- |
| `navigator.webdriver` | WebDriver; pode também aparecer em Playwright, Selenium ou Puppeteer | Pode ser ocultado e pode estar ativo em testes legítimos. Não identifica a ferramenta nem prova intenção. |
| Globais conhecidos de Playwright | Playwright | Implementação pode mudar ou ocultar os nomes; código da página também pode defini-los. |
| Globais conhecidos de Selenium/WebDriver e nomes `cdc_*` | Selenium/WebDriver | Podem não existir, ser renomeados ou ser definidos pela página. |
| `__puppeteer_evaluation_script__` | Puppeteer | Não aparece em toda configuração e pode ser definido pela página. |
| Token `HeadlessChrome` no user agent | Chromium headless | User agent pode ser alterado; headless não prova automação maliciosa. |
| Lista vazia de plugins ou idiomas | Outros indicadores de ambiente | Preferências de privacidade, configuração e versão do navegador podem produzir o mesmo resultado. |

Os registros não combinam sinais em uma pontuação. `no_known_indicators_observed` significa apenas que os indicadores desta lista não foram encontrados; não estabelece uso humano.

## Matriz inicial de avaliação

| Ambiente | Sinais a observar | Limite da avaliação |
| --- | --- | --- |
| Navegador normal | Baseline: normalmente `navigator.webdriver` falso, sem globais conhecidos e user agent sem `HeadlessChrome` | Plugins e idiomas variam por privacidade, configuração e navegador. |
| Playwright | `navigator.webdriver` e globais conhecidos de Playwright | A presença depende do modo de execução e da versão. |
| Selenium | `navigator.webdriver`, globais Selenium conhecidos e marcadores `cdc_*` | Drivers podem remover/alterar os marcadores; a flag pode ser compartilhada com outras ferramentas. |
| Puppeteer | `navigator.webdriver`, global conhecido do Puppeteer e, em headless, token do user agent | Versões e opções de lançamento alteram os sinais visíveis. |
| WebDriver | `navigator.webdriver` e globais Selenium/WebDriver conhecidos | Nem toda implementação expõe globais, e a flag pode ser mascarada. |

Esta matriz é uma lista inicial de hipóteses para executar em navegadores e versões escolhidos pelo avaliador. Os testes deste repositório usam ambientes simulados e verificam a estrutura e o reconhecimento dos marcadores; não afirmam que os frameworks foram executados em navegadores reais.

## Testes

Use Node.js com o executor nativo de testes:

```sh
node --test
```

Os testes cobrem uma baseline simulada de navegador normal, indicadores simulados de Playwright/Selenium/Puppeteer/WebDriver e a interpretação cautelosa quando nenhum indicador conhecido aparece.
