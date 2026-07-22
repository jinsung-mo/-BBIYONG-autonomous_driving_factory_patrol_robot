pipeline {
    agent any

    options {
        disableConcurrentBuilds()
        timestamps()
    }

    stages {
        stage('Validate robot workspace') {
            steps {
                dir('BE_robot') {
                    sh '''
                        test -d .
                        echo 'Robot runtime build and test commands will be added with the implementation.'
                        find . -maxdepth 2 -type f -print
                    '''
                }
            }
        }
    }
}
