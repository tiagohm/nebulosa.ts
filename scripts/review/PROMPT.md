# Instruções para revisão arquivo a arquivo

Você deve realizar uma **revisão técnica profunda de um único arquivo por vez**.

O objetivo principal é encontrar **bugs reais ou riscos concretos de correção**, especialmente em código envolvendo matemática, astronomia, astrometria, mecânica celeste, métodos numéricos, álgebra linear, processamento de imagens e algoritmos científicos.

Não faça uma revisão superficial de estilo. Priorize **correção, robustez numérica, precisão científica e comportamento observável**.

---

## 1. Objetivo principal

Para cada arquivo analisado, determine se o código:

1. realmente implementa corretamente aquilo que se propõe a fazer;
2. produz resultados matematicamente e cientificamente corretos;
3. respeita unidades, sistemas de coordenadas, convenções, sinais, orientações e domínios;
4. trata corretamente casos-limite relevantes;
5. evita perda indevida de precisão numérica;
6. não contém erros lógicos, algorítmicos ou de implementação;
7. quando aplicável, não apresenta gargalos graves de CPU, alocação ou memória.

A prioridade é encontrar **defeitos que possam alterar resultados, produzir resultados incorretos, instabilidade, corrupção de dados, falhas de execução ou desempenho desnecessariamente ruim em caminhos críticos**.

---

## 2. Antes de apontar um problema

Não marque algo como bug apenas porque parece incomum.

Antes de reportar um achado:

- leia o arquivo inteiro e entenda seu propósito;
- examine tipos, constantes, convenções e funções auxiliares utilizadas;
- quando necessário, consulte outros arquivos do projeto para entender contratos e invariantes;
- quando necessário, consulte documentação técnica, artigos, papers, standards ou implementações de referência;
- derive ou valide matematicamente as fórmulas relevantes;
- considere se uma transformação aparentemente estranha é necessária por causa de alguma convenção usada pelo projeto.

Sempre diferencie:

- **bug confirmado**;
- **forte indício de bug**;
- **risco ou fragilidade**, mas sem evidência suficiente de erro atual.

Não reporte especulações vagas.

---

## 3. Matemática, astronomia e algoritmos científicos

Para código matemático, astronômico ou científico, faça uma validação especialmente rigorosa.

Verifique, conforme aplicável:

- fórmulas e derivações;
- sinais;
- ordem das operações;
- fatores multiplicativos;
- constantes;
- unidades;
- normalizações;
- conversões entre graus, radianos, horas, segundos de arco etc.;
- escalas temporais como UTC, UT1, TT, TDB e similares;
- Julian Date e suas convenções;
- épocas e referenciais;
- coordenadas cartesianas, esféricas, equatoriais, eclípticas, horizontais etc.;
- transformações de sistemas de referência;
- precessão, nutação, aberração, paralaxe e refração;
- longitude positiva/negativa e convenções leste/oeste;
- RA circular e transições em `0 ↔ 2π`;
- ângulos próximos dos polos;
- quadrantes de `atan2`;
- normalização angular;
- distâncias e velocidades;
- unidades de `μ`, posição, velocidade e tempo em mecânica orbital;
- propagação orbital;
- soluções iterativas;
- critérios de convergência;
- interpolação;
- extrapolação indevida;
- condicionamento numérico;
- singularidades;
- perda de significância;
- cancelamento catastrófico;
- overflow/underflow;
- estabilidade de polinômios;
- precisão ao trabalhar com valores muito grandes e pequenas diferenças;
- comportamento próximo aos limites do domínio.

Quando existir um algoritmo ou referência científica conhecida, compare a implementação com ela.

Sempre que possível, pense em **casos numéricos concretos capazes de provar ou refutar a correção da implementação**.

---

## 4. Álgebra linear, arrays, matrizes e métodos numéricos

Analise cuidadosamente:

- dimensões;
- stride;
- offset;
- índices;
- ordem row-major/column-major;
- transposição;
- aliasing;
- mutabilidade inesperada;
- buffers compartilhados;
- limites dos arrays;
- inicialização;
- acumulação numérica;
- normalização;
- pivoteamento;
- tolerâncias;
- convergência;
- tratamento de matrizes degeneradas ou mal condicionadas;
- divisão por valores próximos de zero;
- resultados `NaN` ou `Infinity`;
- erros off-by-one.

Se houver TypedArrays, considere também coerção, truncamento e precisão do tipo utilizado.

---

## 5. Processamento de imagem e caminhos computacionalmente pesados

Somente quando o arquivo realmente possuir processamento intensivo — por exemplo:

- imagens;
- grandes matrizes;
- catálogos extensos;
- loops muito frequentes;
- processamento por pixel;
- convoluções;
- FFT;
- stacking;
- detecção de estrelas;
- matching;
- grandes lotes numéricos;

faça também uma revisão de performance e memória.

Procure especialmente:

- alocações dentro de loops críticos;
- criação desnecessária de objetos ou arrays temporários;
- cópias completas evitáveis;
- uso inadequado de `map`, `filter`, `reduce`, spread ou closures em hot paths;
- acesso redundante à memória;
- múltiplas passagens quando uma única passagem seria suficiente;
- complexidade assintótica inadequada;
- loops aninhados desnecessários;
- recomputação de valores invariantes;
- conversões repetidas;
- boxing;
- uso inadequado de estruturas de dados;
- retenção desnecessária de grandes buffers;
- oportunidades claras de reutilização de buffers;
- acesso pouco eficiente a TypedArrays;
- algoritmos com custo muito superior ao necessário.

**Não proponha micro-otimizações sem impacto plausível.**

Reporte performance apenas quando houver um problema relevante ou uma melhoria claramente justificável em um caminho importante.

---

## 6. APIs externas, sockets, rede e protocolos

Para arquivos cujo propósito principal seja integração com:

- APIs HTTP;
- WebSocket;
- TCP/UDP;
- protocolos externos;
- dispositivos;
- serviços remotos;

não faça uma auditoria extensa de design da integração.

Procure apenas **bugs críticos ou concretos**, como:

- request incorreto;
- parâmetros enviados incorretamente;
- parsing errado da resposta;
- framing incorreto;
- leitura parcial tratada como completa;
- mensagens concatenadas ou fragmentadas processadas incorretamente;
- endianess incorreta;
- timeout ou estado que possa quebrar o fluxo;
- race condition evidente;
- uso incorreto de protocolo;
- erro de encoding;
- corrupção ou perda de dados;
- tratamento incorreto de erros que cause comportamento errado;
- incompatibilidade evidente com a especificação externa.

Não gaste tempo sugerindo abstrações, retries, cache, rate limiting ou melhorias arquiteturais, salvo se a ausência causar um bug concreto no comportamento atual.

---

## 7. Leitura de catálogos, arquivos binários e dados tabulares

Em arquivos que leem catálogos, arquivos binários ou formatos científicos, foque em:

- layout;
- offsets;
- tamanho de registros;
- endianess;
- signed/unsigned;
- largura dos campos;
- escala e fatores de conversão;
- unidades;
- sentinelas;
- valores ausentes;
- strings fixas;
- alinhamento;
- ordem dos registros;
- interpretação de flags;
- truncamento;
- overflow;
- leitura além dos limites;
- EOF parcial;
- diferenças entre especificação e implementação.

Evite sugerir refatorações sem relação direta com algum erro.

---

## 8. Coeficientes, tabelas e polinômios

Para arquivos contendo grandes conjuntos de coeficientes ou tabelas numéricas:

- não revise manualmente cada número sem motivo;
- verifique principalmente se a tabela é interpretada corretamente;
- confirme ordem dos termos;
- índices;
- expoentes;
- unidades;
- fatores de escala;
- agrupamento;
- variável independente;
- época;
- avaliação do polinômio;
- esquema de Horner quando aplicável;
- ordem crescente/decrescente dos coeficientes;
- truncamentos;
- seleção de séries;
- combinação dos termos.

Se houver suspeita de coeficiente incorreto, compare com uma fonte de referência antes de reportar.

---

## 9. Bindings de bibliotecas compartilhadas / FFI

Para bindings nativos, FFI ou wrappers de bibliotecas compartilhadas, verifique apenas problemas concretos capazes de causar erro real, como:

- assinatura nativa incorreta;
- tipo incompatível;
- ponteiro inválido;
- tamanho incorreto;
- ownership incorreto;
- lifetime;
- buffer pequeno demais;
- encoding;
- struct layout;
- alinhamento;
- calling convention;
- enum incorreto;
- leitura/escrita fora dos limites;
- uso após liberação;
- argumento de entrada/saída invertido;
- retorno interpretado incorretamente.

Não revise o design da API externa nem proponha reestruturações cosméticas.

---

## 10. TypeScript

Além da lógica científica, procure bugs específicos da linguagem:

- `undefined`/`null` não tratados;
- coerções implícitas;
- comparação incorreta;
- precedência de operadores;
- mutabilidade acidental;
- referências compartilhadas;
- shallow copy quando seria necessária independência;
- `Array.fill` com objetos compartilhados;
- ordenação lexicográfica acidental;
- `Number` fora do intervalo seguro para inteiros;
- conversões `BigInt`/`Number`;
- bitwise operators limitados a 32 bits;
- TypedArrays;
- índices negativos;
- propriedades opcionais;
- narrowing incorreto;
- promises não aguardadas;
- concorrência;
- erros silenciosamente descartados.

Não reporte meras preferências de estilo ou lint.

---

## 11. Casos-limite

Procure casos-limite que sejam plausíveis dentro do domínio real do código.

Exemplos:

- arrays vazios ou com 1 elemento;
- valores exatamente no limite;
- ângulos em `0`, `π`, `2π`;
- coordenadas próximas dos polos;
- RA cruzando `0`;
- vetor de norma zero;
- observações coincidentes;
- intervalos de tempo muito pequenos;
- timestamps muito distantes;
- matriz singular;
- estrela saturada;
- imagem sem estrelas;
- imagem constante;
- tamanho `1×N`;
- dados incompletos;
- catálogo terminando no meio de um registro.

Não invente cenários impossíveis pelo contrato da função.

---

## 12. Compatibilidade com o restante do projeto

Quando necessário, investigue os consumidores da função para confirmar:

- significado dos argumentos;
- unidade esperada;
- mutabilidade;
- convenções;
- contrato de retorno;
- estados válidos;
- interpretação dos resultados.

Um trecho pode estar matematicamente correto isoladamente e ainda assim ser incorreto no projeto devido a uma incompatibilidade de contrato.

---

## 13. O que NÃO deve ocupar a revisão

A menos que cause um bug real, ignore:

- formatação;
- nomes;
- comentários;
- documentação;
- preferência entre `for` e métodos de array fora de hot paths;
- pequenas duplicações;
- arquitetura;
- abstrações;
- organização do arquivo;
- melhorias de legibilidade;
- refatorações cosméticas;
- lint;
- padrões subjetivos de código;
- APIs que poderiam ser mais elegantes;
- tratamento extremamente defensivo de estados impossíveis.

Também não reporte uma função simplesmente por parecer complexa.

---

## 14. Critério de severidade

Classifique cada achado:

### CRITICAL

Pode causar, de forma plausível:

- resultado científico fundamentalmente errado;
- corrupção de memória ou dados;
- crash frequente;
- incompatibilidade grave de protocolo;
- resultado orbital/astrométrico completamente inválido;
- comportamento perigoso no controle de hardware.

### HIGH

Bug que pode:

- produzir resultados materialmente incorretos;
- falhar em condições válidas;
- introduzir erro numérico significativo;
- quebrar um caso de uso importante;
- causar degradação grave de performance ou memória em caminho crítico.

### MEDIUM

Problema real, mas com impacto limitado:

- caso-limite relevante;
- precisão degradada em situações específicas;
- comportamento incorreto pouco frequente;
- desperdício de CPU/memória claramente evitável, porém não catastrófico.

### LOW

Use com muita parcimônia.

Somente reporte se for um defeito real. Não use `LOW` para style nitpicks.

---

## 15. Evidência obrigatória para cada achado

Para cada problema reportado, forneça:

1. **Severidade**
2. **Localização**
    - função/método;
    - trecho ou linhas aproximadas.
3. **Problema**
    - explique exatamente o que está errado.
4. **Por que está errado**
    - derivação, contrato, especificação, referência ou raciocínio técnico.
5. **Condição que dispara o bug**
6. **Impacto observável**
7. **Exemplo reproduzível**
    - valores concretos sempre que possível.
8. **Correção recomendada**
    - solução mínima e tecnicamente correta.
9. **Teste recomendado**
    - descreva um teste que falharia antes da correção e passaria depois.
10. **Confiança**

- `alta`, `média` ou `baixa`.

Se você não consegue explicar tecnicamente por que algo está errado, **não reporte como bug confirmado**.

---

## 16. Validação independente

Quando o arquivo implementar um algoritmo conhecido, tente validar os resultados contra pelo menos uma destas fontes:

- artigo ou paper original;
- standard;
- documentação oficial;
- implementação de referência reconhecida;
- biblioteca científica consolidada;
- valores publicados;
- identidades matemáticas;
- propriedades invariantes;
- cálculo independente.

Para astronomia, priorize quando aplicável fontes como:

- IAU;
- SOFA/ERFA;
- IERS;
- JPL;
- NASA;
- USNO;
- MPC;
- Vallado;
- Meeus;
- referências originais dos modelos implementados.

Não considere outra implementação como necessariamente correta: use-a como evidência adicional.

---

## 17. Verificação por invariantes e propriedades

Além de comparar valores pontuais, procure invariantes.

Exemplos:

- vetores normalizados devem permanecer com norma próxima de `1`;
- matrizes de rotação devem preservar norma e orientação;
- transformação direta + inversa deve recuperar aproximadamente a entrada;
- interpolação deve reproduzir exatamente os nós;
- propagação em `Δt = 0` deve preservar o estado;
- probabilidades devem permanecer no domínio esperado;
- coordenadas devem permanecer em seus domínios;
- resultados devem possuir continuidade quando matematicamente esperado;
- algoritmos simétricos devem respeitar a simetria;
- funções monotônicas devem preservar monotonicidade quando o algoritmo promete isso.

Use esses invariantes para descobrir bugs não óbvios.

---

## 18. Performance: exigir justificativa quantitativa

Ao reportar um problema de performance, explique:

- qual é o hot path;
- qual a complexidade atual;
- por que o volume de dados torna isso relevante;
- qual alocação ou operação está causando custo;
- qual alternativa seria concretamente melhor.

Se possível, estime:

- complexidade assintótica;
- quantidade de alocações;
- número de passagens;
- memória temporária;
- impacto esperado.

Não recomende otimização baseada apenas em preferência pessoal.

---

## 19. Não alterar comportamento correto

Uma recomendação de correção deve preservar:

- API pública, salvo quando o bug estiver no próprio contrato;
- precisão existente;
- convenções utilizadas pelo projeto;
- compatibilidade com consumidores;
- performance, salvo quando houver motivo explícito para trocá-la.

Prefira a **menor alteração capaz de corrigir o defeito**.

---

## 20. Resultado final esperado

Ao terminar a revisão do arquivo, responda nesta estrutura:

### Veredito

Uma frase curta indicando uma destas opções:

- `Nenhum bug relevante encontrado.`
- `Foram encontrados N problemas relevantes.`
- `A implementação requer validação adicional antes de ser considerada correta.`

### Achados

Liste **somente problemas reais e relevantes**, ordenados por severidade.

Para cada um:

```text
[HIGH] Título curto

Localização:
...

Problema:
...

Evidência:
...

Condição:
...

Impacto:
...

Exemplo:
...

Correção:
...

Teste:
...

Confiança: alta
```

### Validações realizadas

Liste sucintamente o que foi efetivamente verificado, por exemplo:

- fórmula comparada com referência X;
- unidades verificadas;
- propriedades/invariantes testados;
- chamadas externas comparadas com especificação;
- complexidade do hot path examinada.

### Pontos que não puderam ser confirmados

Liste apenas aquilo que realmente depende de uma referência, dado externo ou contexto que não estava disponível.

---

## 21. Regra contra falsos positivos

É preferível retornar:

> `Nenhum bug relevante encontrado.`

do que preencher a resposta com hipóteses frágeis.

Não transforme possibilidades teóricas em bugs.

Para um achado entrar na lista principal, deve haver um caminho plausível e tecnicamente defensável entre o código e um comportamento incorreto.

---

## 22. Regra contra falsos negativos

Ao mesmo tempo, não assuma que um algoritmo está correto apenas porque:

- parece sofisticado;
- possui comentários;
- veio de uma referência conhecida;
- possui testes;
- produz números plausíveis;
- está em produção.

Recalcule, derive, compare e procure contraexemplos.

O objetivo desta revisão é **questionar a correção da implementação**, não apenas verificar se o código parece razoável.

---

## 23. Escopo específico desta execução

Analise agora **apenas o arquivo fornecido**.

Use outros arquivos somente quando forem necessários para compreender contratos, tipos, unidades, chamadas ou invariantes.

Não inicie uma revisão genérica do restante do repositório.

Concentre o esforço onde houver maior probabilidade de erro técnico relevante.
