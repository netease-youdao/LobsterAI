"""Canonical GFM table boundaries/cells; no arithmetic or domain decisions."""
import re
import html


def cell(value):
    """Preserve visible inline-code text; GFM requires escaped pipes even in code."""
    text=str(value).replace('\r\n','\n').replace('\r','\n')
    def plain(fragment):
        escaped=html.escape(html.unescape(fragment.replace('\\|','|')),quote=False)
        return escaped.replace('|','\\|').replace('\n','<br>').replace('&lt;br&gt;','<br>')
    pieces=[];cursor=0;search=0
    while search<len(text):
        opening=re.search(r'`+',text[search:])
        if opening is None:break
        start=search+opening.start();stop=search+opening.end();marker=text[start:stop]
        # An escaped opening backtick remains ordinary Markdown text.
        slash_count=0;j=start-1
        while j>=0 and text[j]=='\\':slash_count+=1;j-=1
        if slash_count%2:search=stop;continue
        closing=re.search(r'(?<!`)'+re.escape(marker)+r'(?!`)',text[stop:])
        if closing is None:search=stop;continue
        end_start=stop+closing.start();end_stop=stop+closing.end()
        pieces.append(plain(text[cursor:start]))
        code=text[stop:end_start].replace('\\|','|').replace('|','\\|').replace('\n',' ')
        pieces.append(marker+code+marker);cursor=end_stop;search=end_stop
    pieces.append(plain(text[cursor:]))
    return ''.join(pieces)


def splitcells(line):
    line=line.strip();parts=[];buf='';slashes=0
    for c in line:
        if c=='|' and slashes%2==0:parts.append(buf);buf=''
        else:buf+=c
        slashes=slashes+1 if c=='\\' else 0
    parts.append(buf)
    if line.startswith('|'):parts=parts[1:]
    if line.endswith('|') and parts[-1]=='':parts=parts[:-1]
    return [p.strip() for p in parts]


def normalize(text):
    """Normalize every Markdown table (including empty tables); retain prose outside."""
    source=str(text).splitlines();out=[];i=0;fence=None
    while i<len(source):
        line=source[i];stripped=line.lstrip()
        if stripped.startswith('```') or stripped.startswith('~~~'):
            marker=stripped[:3]
            if fence==marker:fence=None
            elif fence is None:fence=marker
            out.append(line);i+=1;continue
        table=False
        if fence is None and i+1<len(source) and '|' in line:
            head=splitcells(line);sep=splitcells(source[i+1])
            table=bool(sep) and len(head)==len(sep) and all(re.fullmatch(r':?-{3,}:?',x) for x in sep)
        if not table:out.append(line);i+=1;continue
        if out and out[-1]!='':out.append('')
        out+=['|'+'|'.join(cell(x) for x in head)+'|','|'+'|'.join(sep)+'|'];i+=2
        while i<len(source) and source[i].strip() and '|' in source[i] and not source[i].lstrip().startswith(('#','```','~~~')):
            row=splitcells(source[i])
            if len(row)!=len(head):raise ValueError('Markdown表格行列数不一致；字面竖线须写\\|或实体')
            out.append('|'+'|'.join(cell(x) for x in row)+'|');i+=1
        out.append('')
        while i<len(source) and not source[i].strip():i+=1
    return '\n'.join(out).rstrip()+'\n'
