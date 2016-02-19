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

set rtp+=~/.vim/bundle/Vundle.vim
call vundle#begin()

Plugin 'gmarik/Vundle.vim'
Plugin 'pangloss/vim-javascript'
Plugin 'godlygeek/tabular'
Plugin 'tpope/vim-surround'
Plugin 'scrooloose/nerdcommenter'
Plugin 'tpope/vim-markdown'
Plugin 'bling/vim-airline'
Plugin 'kchmck/vim-coffee-script'
Plugin 'flazz/vim-colorschemes'
Plugin 'scrooloose/nerdtree.git'

call vundle#end()            " required
filetype plugin indent on    " required

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

function TwoSpaces()
  set sw=2
  set softtabstop=2
  set expandtab
  echo "tabs are 2 spaces"
endfunction

nmap <S-t> mz:execute TabToggle()<CR>'z
nmap <S-s> mz:execute TwoSpaces()<CR>'z

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

map <C-n> :NERDTreeToggle<CR>
autocmd bufenter * if (winnr("$") == 1 && exists("b:NERDTreeType") && b:NERDTreeType == "primary") | q | endif
