syntax on
set gfn=Monospace\ 8
set autoindent smartindent
set bs=2
set ts=4
set sw=4
set softtabstop=4
set expandtab
map <F3> a<C-R>=strftime("%c")<CR><Esc>
vnoremap , <gv
vnoremap . >gv
nmap <C-e> :vertical resize +1<CR>
nmap <C-b> :vertical resize -1<CR>
nmap <S-e> :resize -1<CR>
nmap <S-b> :resize +1<CR>
"set iskeyword+=.
autocmd FileType python set omnifunc=pythoncomplete#Complete
hi Comment ctermfg=2
map <F5> :!python2.4 %<cr>
map <F6> :!python2.4 % --debug<cr>
map <F1> za
map <F2> zA

set number

map <C-Tab> :tabnext

function TabToggle()
    if &expandtab
        set sw=4
        set ts=4
        set softtabstop=0
        set noexpandtab
        echo "tabs are tabs"
    else
        set shiftwidth=4
        set softtabstop=4
        set expandtab
        echo "tabs are spaces"
    endif
endfunction
nmap <S-t> mz:execute TabToggle()<CR>'z

function NumToggle()
    if &number
        setlocal nonumber
    else
        setlocal number
    endif
endfunction
nmap <S-n> mz:execute NumToggle()<CR>'z


filetype plugin indent on

