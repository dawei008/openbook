Translate OpenBook from Chinese to English.

Source: /home/ubuntu/workspace/openbook/ (Chinese originals - DO NOT modify)
Target: /home/ubuntu/workspace/openbook/en/ (English translations)

RULES:
- Create en/ directory structure mirroring the source
- Keep all Markdown formatting, ASCII diagrams, pseudocode blocks, links
- Keep technical terms in English: Harness, Agent Loop, Dream, Tool, Hook, MCP, Swarm, Mailbox
- Professional technical English, not machine-translation style
- Fix en/ internal links to point within en/ directory
- Each iteration: translate 5 files, then git add and commit

PROGRESS CHECK:
Run: find /home/ubuntu/workspace/openbook/en -name "*.md" 2>/dev/null | wc -l
Target: 44 files total

FILE LIST (44 files):
README.md, preface.md, reading-guide.md, glossary.md, bibliography.md,
part-1/intro.md, part-1/chapter-01.md, part-1/chapter-02.md,
part-2/intro.md, part-2/chapter-03.md, part-2/chapter-04.md, part-2/chapter-05.md,
part-3/intro.md, part-3/chapter-06.md, part-3/chapter-07.md, part-3/chapter-08.md,
part-4/intro.md, part-4/chapter-09.md, part-4/chapter-10.md, part-4/chapter-11.md,
part-5/intro.md, part-5/chapter-12.md, part-5/chapter-13.md, part-5/chapter-14.md, part-5/chapter-15.md,
part-6/intro.md, part-6/chapter-16.md, part-6/chapter-17.md,
part-7/intro.md, part-7/chapter-18.md, part-7/chapter-19.md, part-7/chapter-20.md,
part-8/intro.md, part-8/chapter-21.md, part-8/chapter-22.md,
part-9/intro.md, part-9/chapter-23.md, part-9/chapter-24.md, part-9/chapter-25.md, part-9/chapter-26.md,
appendix/appendix-a.md, appendix/appendix-b.md, appendix/appendix-c.md, appendix/appendix-d.md

DONE CONDITION:
When all 44 files exist in en/ and are committed, output:
<promise>TRANSLATION COMPLETE</promise>
