syntax on
set background=dark
let g:solarized_termcolors=256
"colorscheme solarized

set t_Co=256

set ruler
set number

"set t_Co=256
"colorscheme grb4

set nocompatible               " be iMproved
filetype off                   " required!

set rtp+=~/.vim/bundle/vundle/
call vundle#rc()

Bundle "pangloss/vim-javascript"
Bundle "godlygeek/tabular"
Bundle "tpope/vim-surround"
Bundle "scrooloose/nerdcommenter"
Bundle 'airblade/vim-gitgutter'
Bundle "tpope/vim-markdown"
Bundle 'bling/vim-airline'
Bundle "kchmck/vim-coffee-script"
Bundle 'flazz/vim-colorschemes'

colorscheme jellybeans

filetype plugin indent on


set laststatus=2   " Always show the statusline
set encoding=utf-8 " Necessary to show Unicode glyphs


set gfn=Monospace\ 8
set autoindent smartindent
"set cursorline
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
"autocmd FileType python set omnifunc=pythoncomplete#Complete
"hi Comment ctermfg=2
map <F1> za
map <F2> zA

map <C-Tab> :tabnext
map <C-S-Tab> :tabprev

nmap <Leader>tn :tabnew<CR>
nmap <Leader>th :tabprev<CR>
nmap <Leader>tl :tabnext<CR>

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

nmap <Leader>a= :Tabularize /=<CR>
vmap <Leader>a= :Tabularize /=<CR>
nmap <Leader>a: :Tabularize /:\zs<CR>
vmap <Leader>a: :Tabularize /:\zs<CR>


"set grepprg=grep\ -nH\ $*
"let g:tex_flavor='latex'

function! DoPrettyXML()
  " save the filetype so we can restore it later
  let l:origft = &ft
  set ft=
  " delete the xml header if it exists. This will
  " permit us to surround the document with fake tags
  " without creating invalid xml.
  1s/<?xml .*?>//e
  " insert fake tags around the entire document.
  " This will permit us to pretty-format excerpts of
  " XML that may contain multiple top-level elements.
  0put ='<PrettyXML>'
  $put ='</PrettyXML>'
  silent %!xmllint --format -
  " xmllint will insert an <?xml?> header. it's easy enough to delete
  " if you don't want it.
  " delete the fake tags
  2d
  $d
  " restore the 'normal' indentation, which is one extra level
  " too deep due to the extra tags we wrapped around the document.
  silent %<
  " back to home
  1
  " restore the filetype
  exe "set ft=" . l:origft
endfunction
command! PrettyXML call DoPrettyXML()

